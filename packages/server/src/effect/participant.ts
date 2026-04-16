import { Context, Effect, Layer } from "effect";
import { ErrorCodes } from "@moltzap/protocol";
import { RpcError } from "../rpc/router.js";
import type { AuthenticatedContext } from "../rpc/context.js";
import { Db } from "./services.js";

const tryPromise = <A>(f: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    try: () => f(),
    catch: (err) => (err instanceof Error ? err : new Error(String(err))),
  });

export interface ParticipantService {
  resolve(
    agentId: string,
  ): Effect.Effect<{ exists: boolean; ownerUserId: string | null }, Error>;

  requireExists(
    agentId: string,
  ): Effect.Effect<string | null, RpcError | Error>;
}

export class Participant extends Context.Tag("Participant")<
  Participant,
  ParticipantService
>() {}

export const ParticipantLayer = Layer.effect(
  Participant,
  Effect.map(Db, (db) => {
    const resolve = (
      agentId: string,
    ): Effect.Effect<{ exists: boolean; ownerUserId: string | null }, Error> =>
      Effect.map(
        tryPromise(() =>
          db
            .selectFrom("agents")
            .select(["id", "owner_user_id"])
            .where("id", "=", agentId)
            .where("status", "=", "active")
            .executeTakeFirst(),
        ),
        (row) =>
          row
            ? { exists: true, ownerUserId: row.owner_user_id }
            : { exists: false, ownerUserId: null },
      );

    const requireExists = (
      agentId: string,
    ): Effect.Effect<string | null, RpcError | Error> =>
      Effect.gen(function* () {
        const resolved = yield* resolve(agentId);
        if (!resolved.exists) {
          return yield* Effect.fail(
            new RpcError(ErrorCodes.NotFound, `Agent ${agentId} not found`),
          );
        }
        return resolved.ownerUserId;
      });

    return { resolve, requireExists } satisfies ParticipantService;
  }),
);

export const requireOwnerId = (
  ctx: AuthenticatedContext,
): Effect.Effect<string, RpcError> => {
  const userId = ctx.ownerUserId;
  if (!userId) {
    return Effect.fail(new RpcError(ErrorCodes.Forbidden, "Agent not claimed"));
  }
  return Effect.succeed(userId);
};
