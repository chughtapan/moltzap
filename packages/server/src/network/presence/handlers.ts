import type { AgentContext, AppContext } from "#socket";
import {
  AgentPresenceSubscribe,
  AppPresenceSubscribe,
} from "@moltzap/protocol/network";
import { NotInContactsError } from "@moltzap/protocol/identity";
import type { ParamsOf } from "@moltzap/protocol/rpc";
import type { ServerHandler } from "@moltzap/protocol/socket/catalog";
import type { AgentId } from "@moltzap/protocol/identity";
import { Effect } from "effect";
import { ConnectionTag, DbTag, PresenceServiceTag } from "#core";
import { visibleAgentIds } from "#identity/agents";
import { agentArm, appArm } from "#moltzap/runtime";

/**
 * `network/presence/subscribe` registers fan-out interest via
 * `PresenceService.subscribe` and reads the current status snapshot via
 * `PresenceService.statusMany`. Presence is server-derived from `LeaseRegistry`
 * lifecycle + WS connect/disconnect; there is no client-driven
 * `presence/update`.
 *
 * Contact-scoped: throw NotInContactsError when any requested agentId falls
 * outside the caller's visibility set.
 */
function presenceSubscribeBody(
  params: ParamsOf<typeof AgentPresenceSubscribe>,
  ctx: AgentContext | AppContext,
) {
  return Effect.gen(function* () {
    const presenceService = yield* PresenceServiceTag;
    const connection = yield* ConnectionTag;
    const requested = params.agentIds;

    let subscribedIds: ReadonlyArray<AgentId>;
    if (ctx._tag === "AgentContext") {
      const db = yield* DbTag;
      const visibleIds = yield* visibleAgentIds({
        db,
        callerAgentId: ctx.agentId,
        callerOwnerUserId: ctx.ownerUserId,
        restrictTo: requested,
      });
      const visibleSet = new Set(visibleIds);
      const rejected = requested.filter((id) => !visibleSet.has(id));
      if (rejected.length > 0) {
        return yield* Effect.fail(
          new NotInContactsError({ data: { agentIds: rejected } }),
        );
      }
      subscribedIds = visibleIds;
    } else {
      subscribedIds = requested;
    }
    presenceService.subscribe(connection.connId, subscribedIds);
    // The status snapshot is a ReadonlyArray; the wire schema expects a mutable
    // Array, so map to a fresh array (point-in-time copy).
    const projected = yield* presenceService.statusMany(subscribedIds);
    const statuses = projected.map((entry) => ({
      agentId: entry.agentId,
      status: entry.status,
    }));
    return { statuses };
  }).pipe(Effect.withSpan("presence.subscribe"));
}

// ── @effect/rpc handler body ─────────────────────────────────────────

export const agentPresenceSubscribe: ServerHandler<
  typeof AgentPresenceSubscribe
> = (params) =>
  Effect.gen(function* () {
    return yield* presenceSubscribeBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("agentPresenceSubscribe"));

export const appPresenceSubscribe: ServerHandler<
  typeof AppPresenceSubscribe
> = (params) =>
  Effect.gen(function* () {
    return yield* presenceSubscribeBody(params, yield* appArm);
  }).pipe(Effect.withSpan("appPresenceSubscribe"));
