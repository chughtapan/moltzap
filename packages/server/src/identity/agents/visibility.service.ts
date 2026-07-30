/**
 * Contact-scoped agent visibility. Used by `agent/identity/agents/list` and
 * `network/presence/subscribe`. The visible set for a caller is:
 *   - the caller's own agentId,
 *   - agents owned by the caller's `ownerUserId`,
 *   - agents owned by an `accepted`-status contact of the caller's
 *     `ownerUserId`.
 */
import { Effect } from "effect";
import { type Db, catchSqlErrorAsDefect } from "#db";
import type { AgentId, UserId } from "@moltzap/protocol/identity";

/** Describes visible agent ids request. */
export interface VisibleAgentIdsRequest {
  readonly db: Db;
  readonly callerAgentId: AgentId;
  readonly callerOwnerUserId: UserId;
  /** When set, intersect the visible set with these IDs. */
  readonly restrictTo?: readonly AgentId[];
}

/**
 * Executes the visible agent ids operation.
 * @param req Value supplied to the operation.
 * @returns The visible agent ids result.
 */
export function visibleAgentIds(
  req: VisibleAgentIdsRequest,
): Effect.Effect<readonly AgentId[]> {
  const { db, callerAgentId, callerOwnerUserId, restrictTo } = req;

  if (restrictTo !== undefined && restrictTo.length === 0) {
    return Effect.succeed([]);
  }

  return catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const baseSelect = db.selectFrom("agents").select("id");
      const filtered =
        restrictTo === undefined
          ? baseSelect
          : baseSelect.where("id", "in", restrictTo);
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
    }).pipe(Effect.withSpan("visibleAgentIds")),
  );
}
