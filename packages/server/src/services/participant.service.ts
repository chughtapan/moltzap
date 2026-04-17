import type { Db } from "../db/client.js";
import { Effect, Option } from "effect";
import { RpcFailure, notFound, forbidden } from "../runtime/index.js";
import type { AuthenticatedContext } from "../rpc/context.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
} from "../db/effect-kysely-toolkit.js";

/**
 * Shared utility for resolving and validating agent references.
 */
export class ParticipantService {
  constructor(private db: Db) {}

  resolve(
    agentId: string,
  ): Effect.Effect<
    { exists: boolean; ownerUserId: string | null },
    RpcFailure
  > {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rowOpt = yield* takeFirstOption(
          this.db
            .selectFrom("agents")
            .select(["id", "owner_user_id"])
            .where("id", "=", agentId)
            .where("status", "=", "active"),
        );
        if (Option.isNone(rowOpt)) return { exists: false, ownerUserId: null };
        return {
          exists: true,
          ownerUserId: rowOpt.value.owner_user_id,
        };
      }),
    );
  }

  requireExists(agentId: string): Effect.Effect<string | null, RpcFailure> {
    return Effect.gen(this, function* () {
      const resolved = yield* this.resolve(agentId);
      if (!resolved.exists) {
        return yield* Effect.fail(notFound(`Agent ${agentId} not found`));
      }
      return resolved.ownerUserId;
    });
  }

  /** Get owner user ID or throw Forbidden. Use in handlers that require a claimed agent. */
  static requireOwnerId(
    ctx: AuthenticatedContext,
  ): Effect.Effect<string, RpcFailure> {
    const userId = ctx.ownerUserId;
    if (!userId) {
      return Effect.fail(forbidden("Agent not claimed"));
    }
    return Effect.succeed(userId);
  }
}
