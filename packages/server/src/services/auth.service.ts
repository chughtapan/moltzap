import { Effect, Option } from "effect";
import { sql } from "kysely";
import type { Db } from "../db/client.js";
import type { Register, Static } from "@moltzap/protocol";
import { AgentId, UserId } from "../app/types.js";

type RegisterParams = Static<typeof Register.paramsSchema>;
import {
  generateApiKey,
  generateClaimToken,
  parseApiKey,
  hashSecret,
} from "../auth/agent-auth.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
  takeFirstOrFail,
} from "../db/effect-kysely-toolkit.js";

export const REGISTRATION_CONFLICT = "RegistrationConflict" as const;

export type UpsertAgentResult =
  | { agentId: AgentId; apiKey: string; rotated: boolean }
  | { _tag: typeof REGISTRATION_CONFLICT };

export class AuthService {
  constructor(private db: Db) {}

  registerAgent(
    params: RegisterParams,
    /**
     * When set, populates `owner_user_id` at insert time. Callers MUST
     * validate the value upstream — this argument is treated as trusted.
     */
    ownerUserId?: string,
  ): Effect.Effect<{ agentId: AgentId; apiKey: string }, never> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const { apiKey, keyId, secretHash } = generateApiKey();

        const result = yield* takeFirstOrFail(
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
            .returning(["id"]),
          "Failed to insert agent",
        );

        const agentId = AgentId(result.id);

        yield* Effect.logInfo("Agent registered").pipe(
          Effect.annotateLogs({ agentId, name: params.name }),
        );

        return { agentId, apiKey };
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
        const agentId = AgentId(id);
        const rotated = !inserted;

        yield* Effect.logInfo("Agent upserted").pipe(
          Effect.annotateLogs({ agentId, name: params.name, rotated }),
        );

        return { agentId, apiKey, rotated };
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
        return rows.map((r) => AgentId(r.id));
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
          agentId: AgentId(row.id),
          status: row.status,
          ownerUserId:
            row.owner_user_id === null ? null : UserId(row.owner_user_id),
        };
      }),
    );
  }
}
