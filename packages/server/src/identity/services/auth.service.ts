import { Effect, Option } from "effect";
import type { Db } from "../../db/client.js";
import { sql } from "../../db/sql.js";
import type { ParamsOf, Register } from "@moltzap/protocol";
import type { AgentId, UserId } from "../../app/types.js";

type RegisterParams = ParamsOf<typeof Register>;
import {
  generateApiKey,
  generateClaimToken,
  parseApiKey,
  hashSecret,
} from "../../identity/services/agent-auth.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
  takeFirstOrFail,
} from "../../db/effect-kysely-toolkit.js";

const REGISTRATION_CONFLICT = "RegistrationConflict" as const;

export type UpsertAgentResult =
  | { agentId: AgentId; apiKey: string; rotated: boolean }
  | { _tag: typeof REGISTRATION_CONFLICT };

/**
 * Tags for `claimAgent`'s discriminated union. Error tags double as the
 * wire-level `code` on the HTTP response so callers (and test
 * assertions) reference one constant rather than maintaining parallel
 * string namespaces.
 */
export const CLAIM_SUCCESS = "CLAIM_SUCCESS" as const;
export const CLAIM_NOT_FOUND = "CLAIM_NOT_FOUND" as const;
export const CLAIM_OWNER_MISMATCH = "CLAIM_OWNER_MISMATCH" as const;

export type ClaimAgentResult =
  | {
      _tag: typeof CLAIM_SUCCESS;
      agentId: AgentId;
      ownerUserId: string;
      alreadyClaimed: boolean;
    }
  | { _tag: typeof CLAIM_NOT_FOUND }
  | { _tag: typeof CLAIM_OWNER_MISMATCH };

export class AuthService {
  constructor(private db: Db) {}

  registerAgent(
    params: RegisterParams,

    /**
     * When set, populates `owner_user_id` at insert time. Callers MUST
     * validate the value upstream — this argument is treated as trusted.
     */
    ownerUserId?: string,
  ): Effect.Effect<
    { agentId: AgentId; apiKey: string; claimToken: string },
    never
  > {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const { apiKey, keyId, secretHash } = generateApiKey();
        const claimToken = generateClaimToken();

        const result = yield* takeFirstOrFail(
          this.db
            .insertInto("agents")
            .values({
              name: params.name,
              description: params.description ?? null,
              api_key_id: keyId,
              api_key_secret_hash: secretHash,
              claim_token: claimToken,
              status: "active",
              owner_user_id: ownerUserId ?? null,
            })
            .returning(["id"]),
          "Failed to insert agent",
        );

        const agentId = result.id;

        yield* Effect.logInfo("Agent registered").pipe(
          Effect.annotateLogs({ agentId, name: params.name }),
        );

        // claimToken matches the `Register.result` protocol schema; it
        // is the credential the `auth/claim` route accepts to bind
        // `owner_user_id` (#486). Pre-#486 it had no consumer, so the
        // implementation diverged from the schema by omitting it.
        return { agentId, apiKey, claimToken };
      }),
    );
  }

  /**
   * Reentrant register. INSERT new row, or rotate api_key_id /
   * api_key_secret_hash on an existing row when `(name)` matches AND the
   * existing owner matches AND the row is not suspended. Otherwise return
   * `RegistrationConflict`.
   *
   * Atomic on `agents.name UNIQUE` — concurrent callers serialize on the
   * row lock and second-write wins (most-recent admin upsert is source of
   * truth). Public `/auth/register` stays insert-only: reentrancy without
   * an owner-match WHERE would let any `REGISTRATION_SECRET` holder mint a
   * fresh apiKey for any existing agent.
   */
  upsertAgent(
    params: RegisterParams,
    ownerUserId?: string,
  ): Effect.Effect<UpsertAgentResult, never> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const { apiKey, keyId, secretHash } = generateApiKey();

        const rowOpt = yield* takeFirstOption(
          this.db
            .insertInto("agents")
            .values({
              name: params.name,
              description: params.description ?? null,
              api_key_id: keyId,
              api_key_secret_hash: secretHash,
              claim_token: generateClaimToken(),
              status: "active",
              owner_user_id: ownerUserId ?? null,
            })
            .onConflict((oc) =>
              oc
                .column("name")
                .doUpdateSet({
                  api_key_id: keyId,
                  api_key_secret_hash: secretHash,
                })
                // WHERE failure → no UPDATE → RETURNING yields zero rows,
                // which maps to RegistrationConflict.
                .where(
                  sql<boolean>`agents.owner_user_id IS NOT DISTINCT FROM EXCLUDED.owner_user_id AND agents.status != 'suspended'`,
                ),
            )
            // `xmax = 0` distinguishes a fresh INSERT from a conflict
            // UPDATE; PG system column with no Kysely abstraction.
            .returning(["id", sql<boolean>`(xmax = 0)`.as("inserted")]),
        );

        if (Option.isNone(rowOpt)) {
          yield* Effect.logInfo("Agent upsert conflict").pipe(
            Effect.annotateLogs({ name: params.name }),
          );
          return { _tag: REGISTRATION_CONFLICT } as const;
        }

        const { id, inserted } = rowOpt.value;
        const agentId = id;
        const rotated = !inserted;

        yield* Effect.logInfo("Agent upserted").pipe(
          Effect.annotateLogs({ agentId, name: params.name, rotated }),
        );

        return { agentId, apiKey, rotated };
      }),
    );
  }

  /**
   * Bind an unclaimed agent to `ownerUserId`. The `claimToken` originates
   * from a prior `auth/register` call and is the authentication for this
   * mutation — only the holder of the token can claim. Idempotent: a
   * repeat claim with the same `(claimToken, ownerUserId)` succeeds and
   * returns the existing binding. A repeat claim with a different
   * `ownerUserId` is rejected with `CLAIM_OWNER_MISMATCH` so the
   * impersonation footgun (#486) cannot be reopened post-claim.
   *
   * Atomicity: the WHERE on `owner_user_id IS NULL` lets concurrent
   * claims race safely — only one transaction's UPDATE binds the row;
   * the other observes 0 affected rows and falls through to the SELECT
   * branch where it can either succeed (idempotent re-claim by same
   * owner) or be rejected as a conflict. Postgres row-locking
   * serializes the writers; readers see committed state.
   */
  claimAgent(params: {
    readonly claimToken: string;
    readonly ownerUserId: string;
  }): Effect.Effect<ClaimAgentResult, never> {
    const { claimToken, ownerUserId } = params;
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        // First-claim path: bind owner_user_id only if currently NULL.
        // RETURNING `id` so we can distinguish "row updated" from "no
        // matching row" without a second SELECT round-trip on the happy
        // path.
        const updateRowOpt = yield* takeFirstOption(
          this.db
            .updateTable("agents")
            .set({ owner_user_id: ownerUserId })
            .where("claim_token", "=", claimToken)
            .where("owner_user_id", "is", null)
            .returning(["id"]),
        );

        if (Option.isSome(updateRowOpt)) {
          const agentId = updateRowOpt.value.id;
          yield* Effect.logInfo("Agent claimed").pipe(
            Effect.annotateLogs({ agentId, ownerUserId }),
          );
          return {
            _tag: CLAIM_SUCCESS,
            agentId,
            ownerUserId,
            alreadyClaimed: false,
          } as const;
        }

        // No row updated: either the token is unknown (not-found) or the
        // row is already claimed. Fall through to a SELECT to
        // disambiguate.
        const selectRowOpt = yield* takeFirstOption(
          this.db
            .selectFrom("agents")
            .select(["id", "owner_user_id"])
            .where("claim_token", "=", claimToken),
        );

        if (Option.isNone(selectRowOpt)) {
          return { _tag: CLAIM_NOT_FOUND } as const;
        }

        const row = selectRowOpt.value;
        if (row.owner_user_id === ownerUserId) {
          // Idempotent re-claim by the same owner.
          return {
            _tag: CLAIM_SUCCESS,
            agentId: row.id,
            ownerUserId,
            alreadyClaimed: true,
          } as const;
        }
        return { _tag: CLAIM_OWNER_MISMATCH } as const;
      }),
    );
  }

  agentsForOwner(
    ownerUserId: UserId,
  ): Effect.Effect<ReadonlyArray<AgentId>, never> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rows = yield* this.db
          .selectFrom("agents")
          .select(["id"])
          .where("owner_user_id", "=", ownerUserId)
          .where("status", "=", "active");
        return rows.map((r) => r.id);
      }),
    );
  }

  authenticateAgent(apiKey: string): Effect.Effect<
    {
      agentId: AgentId;
      status: string;
      ownerUserId: UserId | null;
    } | null,
    never
  > {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const parsed = parseApiKey(apiKey);
        if (!parsed) return null;

        const rowOpt = yield* takeFirstOption(
          this.db
            .selectFrom("agents")
            .select(["id", "api_key_secret_hash", "status", "owner_user_id"])
            .where("api_key_id", "=", parsed.keyId)
            .where("status", "!=", "suspended"),
        );

        if (Option.isNone(rowOpt)) return null;
        const row = rowOpt.value;
        if (hashSecret(parsed.secret) !== row.api_key_secret_hash) return null;

        return {
          agentId: row.id,
          status: row.status,
          ownerUserId: row.owner_user_id,
        };
      }),
    );
  }
}
