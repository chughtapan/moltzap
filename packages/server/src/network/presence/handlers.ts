import type { AgentContext } from "#socket";
import {
  AgentPresenceSubscribe,
  AppPresenceSubscribe,
} from "@moltzap/protocol/network";
import { NotInContactsError } from "@moltzap/protocol/identity";
import type { ServerHandler } from "@moltzap/protocol/socket/catalog";
import type { AgentId } from "@moltzap/protocol/identity";
import { Effect } from "effect";
import { DbTag } from "#db";
import { PresenceServiceTag } from "./layer.js";
import { visibleAgentIds } from "#identity/agents";
import { agentArm, appArm } from "#moltzap/runtime";

/**
 * `network/presence/subscribe` reads the current status snapshot via
 * `PresenceService.statusMany`. Presence is server-derived from
 * `LeaseRegistry` lifecycle + WS connect/disconnect; there is no
 * client-driven `presence/update`.
 *
 * Agent subscriptions are contact-scoped; app subscriptions can observe the
 * agents they manage without an agent contact graph.
 */
function presenceSnapshot(agentIds: ReadonlyArray<AgentId>) {
  return Effect.gen(function* () {
    const presenceService = yield* PresenceServiceTag;
    const projected = yield* presenceService.statusMany(agentIds);
    const statuses = projected.map((entry) => ({
      agentId: entry.agentId,
      status: entry.status,
    }));
    return { statuses };
  }).pipe(Effect.withSpan("presence.subscribe"));
}

function visiblePresenceAgentIds(
  requested: ReadonlyArray<AgentId>,
  ctx: AgentContext,
) {
  return Effect.gen(function* () {
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
    return visibleIds;
  }).pipe(Effect.withSpan("presence.visibleAgentIds"));
}

// ── @effect/rpc handler body ─────────────────────────────────────────

export const agentPresenceSubscribe: ServerHandler<
  typeof AgentPresenceSubscribe
> = (params) =>
  Effect.gen(function* () {
    const subscribedIds = yield* visiblePresenceAgentIds(
      params.agentIds,
      yield* agentArm,
    );
    return yield* presenceSnapshot(subscribedIds);
  }).pipe(Effect.withSpan("agentPresenceSubscribe"));

export const appPresenceSubscribe: ServerHandler<
  typeof AppPresenceSubscribe
> = (params) =>
  Effect.gen(function* () {
    yield* appArm;
    return yield* presenceSnapshot(params.agentIds);
  }).pipe(Effect.withSpan("appPresenceSubscribe"));
