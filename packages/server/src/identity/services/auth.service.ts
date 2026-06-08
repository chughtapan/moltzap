import { Effect, Option } from "effect";
import type { Db } from "../../db/client.js";
import type { AgentKey } from "@moltzap/protocol/identity";
import type { Register } from "@moltzap/protocol/identity";
import type { ParamsOf } from "@moltzap/protocol/transport";
import type { AgentId, UserId } from "#core";

type RegisterParams = ParamsOf<typeof Register>;
import {
  generateApiKey,
  parseApiKey,
  hashSecret,
} from "../../identity/services/credential-keys.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
  takeFirstOrFail,
} from "../../db/effect-kysely-toolkit.js";

export class AuthService {
  constructor(private db: Db) {}

  registerAgent(
    params: RegisterParams,

    /**
     * Populates `owner_user_id` at insert time. Callers MUST validate the value
     * upstream — this argument is treated as trusted.
     */
    ownerUserId: UserId,
  ): Effect.Effect<{ agentId: AgentId; apiKey: AgentKey }, never> {
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

  authenticateAgent(apiKey: AgentKey): Effect.Effect<
    {
      agentId: AgentId;
      status: string;
      ownerUserId: UserId;
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
