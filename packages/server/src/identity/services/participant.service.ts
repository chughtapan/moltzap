import type { Db } from "../../db/client.js";
import { Effect, Option } from "effect";
import { ForbiddenError, NotFoundError } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { AuthenticatedContext } from "../../transport/context.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
} from "../../db/effect-kysely-toolkit.js";

/**
 * Shared utility for resolving and validating agent references.
 */
export class ParticipantService {
  constructor(private db: Db) {}

  resolve(
    agentId: AgentId,
  ): Effect.Effect<{ exists: boolean; ownerUserId: string | null }> {
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

  assertAgentExists(
    agentId: AgentId,
  ): Effect.Effect<string | null, NotFoundError> {
    return Effect.gen(this, function* () {
      const resolved = yield* this.resolve(agentId);
      if (!resolved.exists) {
        return yield* Effect.fail(
          new NotFoundError({ message: `Agent ${agentId} not found` }),
        );
      }
      return resolved.ownerUserId;
    });
  }

  /** Get owner user ID or throw Forbidden. Use in handlers that require a claimed agent. */
  static assertOwnerId(
    ctx: AuthenticatedContext,
  ): Effect.Effect<string, ForbiddenError> {
    const userId = ctx.ownerUserId;
    if (!userId) {
      return Effect.fail(new ForbiddenError({ message: "Agent not claimed" }));
    }
    return Effect.succeed(userId);
  }
}
