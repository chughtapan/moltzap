import { Context, Effect } from "effect";
import type { RegisterParams } from "@moltzap/protocol";
import {
  generateApiKey,
  generateClaimToken,
  parseApiKey,
  hashSecret,
} from "../auth/agent-auth.js";
import { Db, Log, tryDb } from "./services.js";

export interface AuthServiceShape {
  registerAgent(
    params: RegisterParams,
  ): Effect.Effect<{ agentId: string; apiKey: string }, Error, never>;

  authenticateAgent(apiKey: string): Effect.Effect<
    {
      agentId: string;
      status: string;
      ownerUserId: string | null;
    } | null,
    Error,
    never
  >;
}

export class Auth extends Context.Tag("Auth")<Auth, AuthServiceShape>() {}

export const AuthLive = Effect.all([Db, Log]).pipe(
  Effect.map(([_db, logger]) => {
    const registerAgent = (
      params: RegisterParams,
    ): Effect.Effect<{ agentId: string; apiKey: string }, Error> =>
      Effect.gen(function* () {
        const { apiKey, keyId, secretHash } = generateApiKey();

        const result = yield* tryDb((db) =>
          db
            .insertInto("agents")
            .values({
              name: params.name,
              description: params.description ?? null,
              api_key_id: keyId,
              api_key_secret_hash: secretHash,
              claim_token: generateClaimToken(),
              status: "active",
            })
            .returning(["id"])
            .executeTakeFirstOrThrow(),
        );

        const agentId = result.id;
        logger.info({ agentId, name: params.name }, "Agent registered");

        return { agentId, apiKey };
      });

    const authenticateAgent = (
      apiKey: string,
    ): Effect.Effect<
      {
        agentId: string;
        status: string;
        ownerUserId: string | null;
      } | null,
      Error
    > =>
      Effect.gen(function* () {
        const parsed = parseApiKey(apiKey);
        if (!parsed) return null;

        const row = yield* tryDb((db) =>
          db
            .selectFrom("agents")
            .select(["id", "api_key_secret_hash", "status", "owner_user_id"])
            .where("api_key_id", "=", parsed.keyId)
            .where("status", "!=", "suspended")
            .executeTakeFirst(),
        );

        if (!row) return null;
        if (hashSecret(parsed.secret) !== row.api_key_secret_hash) return null;

        return {
          agentId: row.id,
          status: row.status,
          ownerUserId: row.owner_user_id ?? null,
        };
      });

    return { registerAgent, authenticateAgent } satisfies AuthServiceShape;
  }),
);

export const AuthLayer = Effect.toLayer(AuthLive, Auth);
