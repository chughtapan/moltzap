import { Context, Effect } from "effect";
import { ErrorCodes } from "@moltzap/protocol";
import { RpcError } from "../rpc/router.js";
import type { AuthenticatedContext } from "../rpc/context.js";
import { Db, tryDb } from "./services.js";

export interface ParticipantService {
  resolve(
    agentId: string,
  ): Effect.Effect<
    { exists: boolean; ownerUserId: string | null },
    Error,
    never
  >;

  requireExists(
    agentId: string,
  ): Effect.Effect<string | null, RpcError | Error, never>;
}

export class Participant extends Context.Tag("Participant")<
  Participant,
  ParticipantService
>() {}

export const ParticipantLive = Effect.map(Db, (_db) => {
  const resolve = (
    agentId: string,
  ): Effect.Effect<{ exists: boolean; ownerUserId: string | null }, Error> =>
    tryDb((db) =>
      db
        .selectFrom("agents")
        .select(["id", "owner_user_id"])
        .where("id", "=", agentId)
        .where("status", "=", "active")
        .executeTakeFirst()
        .then((row) =>
          row
            ? { exists: true as const, ownerUserId: row.owner_user_id }
            : { exists: false as const, ownerUserId: null },
        ),
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
});

export const ParticipantLayer = Effect.toLayer(ParticipantLive, Participant);

export const requireOwnerId = (
  ctx: AuthenticatedContext,
): Effect.Effect<string, RpcError> => {
  const userId = ctx.ownerUserId;
  if (!userId) {
    return Effect.fail(new RpcError(ErrorCodes.Forbidden, "Agent not claimed"));
  }
  return Effect.succeed(userId);
};
