/**
 * Contact-scoped agent visibility (#481). Used by `agents/list` and
 * `presence/subscribe`. The visible set for a caller is:
 *   - the caller's own agentId,
 *   - agents owned by the caller's `ownerUserId`,
 *   - agents owned by an `accepted`-status contact of the caller's
 *     `ownerUserId`.
 */
import { Effect } from "effect";
import type { Db } from "../../db/client.js";
import type { AgentId, UserId } from "../../app/types.js";
import { catchSqlErrorAsDefect } from "../../db/effect-kysely-toolkit.js";

export interface VisibleAgentIdsRequest {
  readonly db: Db;
  readonly callerAgentId: AgentId;
  readonly callerOwnerUserId: UserId | null;
  /** When set, intersect the visible set with these IDs. */
  readonly restrictTo?: ReadonlyArray<AgentId>;
}

export function visibleAgentIds(
  req: VisibleAgentIdsRequest,
): Effect.Effect<ReadonlyArray<AgentId>, never> {
  const { db, callerAgentId, callerOwnerUserId, restrictTo } = req;

  if (restrictTo !== undefined && restrictTo.length === 0) {
    return Effect.succeed([]);
  }

  // Unclaimed callers can only see themselves.
  if (callerOwnerUserId === null) {
    if (restrictTo === undefined) {
      return Effect.succeed([callerAgentId]);
    }
    return Effect.succeed(
      restrictTo.includes(callerAgentId) ? [callerAgentId] : [],
    );
  }

  return catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const baseSelect = db.selectFrom("agents").select("id");
      const filtered =
        restrictTo === undefined
          ? baseSelect
          : baseSelect.where("id", "in", restrictTo as AgentId[]);
      const rows = yield* filtered.where((eb) =>
        eb.or([
          eb("id", "=", callerAgentId),
          eb("owner_user_id", "=", callerOwnerUserId),
          eb(
            "owner_user_id",
            "in",
            eb
              .selectFrom("contacts")
              .select("contact_user_id")
              .where("owner_user_id", "=", callerOwnerUserId)
              .where("status", "=", "accepted"),
          ),
        ]),
      );
      return rows.map((r) => r.id);
    }),
  );
}
