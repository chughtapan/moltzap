import { Effect, Option } from "effect";
import {
  type Db,
  catchSqlErrorAsDefect,
  takeFirstOption,
  takeFirstOrFail,
} from "#db";
import type {
  AgentKey,
  register,
  AgentId,
  UserId,
} from "@moltzap/protocol/identity";
import type { ParamsOf } from "@moltzap/protocol/rpc";

type RegisterParams = ParamsOf<typeof register>;
import {
  generateApiKey,
  parseApiKey,
  hashSecret,
} from "#identity/credential-keys";

/** Implements auth service. */
export class AuthService {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  registerAgent(
    params: RegisterParams,

    /**
     * Populates `owner_user_id` at insert time. Callers MUST validate the value
     * upstream — this argument is treated as trusted.
     */
    ownerUserId: UserId,
  ): Effect.Effect<{ agentId: AgentId; apiKey: AgentKey }> {
    return catchSqlErrorAsDefect(
      Effect.gen(
        function* (this: AuthService) {
          const { apiKey, keyId, secretHash } = generateApiKey();

          const result = yield* takeFirstOrFail(
            this.db
              .insertInto("agents")
              .values({
                name: params.name,
                description: params.description ?? null,
                api_key_id: keyId,
                api_key_secret_hash: secretHash,
                status: "active",
                owner_user_id: ownerUserId,
              })
              .returning(["id"]),
            "Failed to insert agent",
          );

          const agentId = result.id;

          yield* Effect.logInfo("Agent registered").pipe(
            Effect.annotateLogs({ agentId, name: params.name }),
          );

          return { agentId, apiKey };
        }.bind(this),
      ),
    );
  }

  agentsForOwner(ownerUserId: UserId): Effect.Effect<readonly AgentId[]> {
    return catchSqlErrorAsDefect(
      Effect.gen(
        function* (this: AuthService) {
          const rows = yield* this.db
            .selectFrom("agents")
            .select(["id"])
            .where("owner_user_id", "=", ownerUserId)
            .where("status", "=", "active");
          return rows.map((r) => r.id);
        }.bind(this),
      ),
    );
  }

  authenticateAgent(apiKey: AgentKey): Effect.Effect<{
    agentId: AgentId;
    status: string;
    ownerUserId: UserId;
  } | null> {
    return catchSqlErrorAsDefect(
      Effect.gen(
        function* (this: AuthService) {
          const parsed = parseApiKey(apiKey);
          if (!parsed) {
            return null;
          }

          const rowOpt = yield* takeFirstOption(
            this.db
              .selectFrom("agents")
              .select(["id", "api_key_secret_hash", "status", "owner_user_id"])
              .where("api_key_id", "=", parsed.keyId)
              .where("status", "!=", "suspended"),
          );

          if (Option.isNone(rowOpt)) {
            return null;
          }
          const row = rowOpt.value;
          if (hashSecret(parsed.secret) !== row.api_key_secret_hash) {
            return null;
          }

          return {
            agentId: row.id,
            status: row.status,
            ownerUserId: row.owner_user_id,
          };
        }.bind(this),
      ),
    );
  }
}
// safer-arch-ignore folder-explicit-api-required: AuthService is the identity/agents service boundary consumed directly by composition code to avoid handler-barrel cycles.
