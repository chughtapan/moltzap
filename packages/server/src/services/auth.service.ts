import { Effect } from "effect";
import type { Db } from "../db/client.js";
import type { Register, Static } from "@moltzap/protocol";

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
import { Option } from "effect";

export class AuthService {
  constructor(private db: Db) {}

  registerAgent(
    params: RegisterParams,
  ): Effect.Effect<{ agentId: string; apiKey: string }, never> {
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

  authenticateAgent(apiKey: string): Effect.Effect<
    {
      agentId: string;
      status: string;
      ownerUserId: string | null;
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
          ownerUserId: row.owner_user_id ?? null,
        };
      }),
    );
  }
}
