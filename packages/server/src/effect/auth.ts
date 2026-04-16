import { Context, Effect, Layer } from "effect";
import type { RegisterParams } from "@moltzap/protocol";
import {
  generateApiKey,
  generateClaimToken,
  parseApiKey,
  hashSecret,
} from "../auth/agent-auth.js";
import { Db, Log } from "./services.js";

const tryPromise = <A>(f: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: () => f(),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  });

export interface AuthServiceShape {
  registerAgent(
    params: RegisterParams,
  ): Effect.Effect<{ agentId: string; apiKey: string }, Error>;

  authenticateAgent(apiKey: string): Effect.Effect<{
    agentId: string;
    status: string;
    ownerUserId: string | null;
  } | null, Error>;
}

export class Auth extends Context.Tag("Auth")<Auth, AuthServiceShape>() {}

export const AuthLayer = Layer.effect(
  Auth,
  Effect.map(Effect.all([Db, Log]), ([db, logger]) => {
    const registerAgent = (
      params: RegisterParams,
    ): Effect.Effect<{ agentId: string; apiKey: string }, Error> =>
      Effect.gen(function* () {
        const { apiKey, keyId, secretHash } = generateApiKey();

        const result = yield* tryPromise(() =>
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

        const row = yield* tryPromise(() =>
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
