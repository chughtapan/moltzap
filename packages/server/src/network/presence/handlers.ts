import type { AgentContext } from "#socket";
import type {
  agentPresenceSubscribe as agentPresenceSubscribeDefinition,
  appPresenceSubscribe as appPresenceSubscribeDefinition,
} from "@moltzap/protocol/network";
import { NotInContactsError, type AgentId } from "@moltzap/protocol/identity";
import type { ServerHandler } from "@moltzap/protocol/socket/catalog";
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
 * @param agentIds Value supplied to the operation.
 * @returns The presence snapshot result.
 */
function presenceSnapshot(agentIds: readonly AgentId[]) {
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
  requested: readonly AgentId[],
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
      return yield* new NotInContactsError({ data: { agentIds: rejected } });
    }
    return visibleIds;
  }).pipe(Effect.withSpan("presence.visibleAgentIds"));
}

// ── @effect/rpc handler body ─────────────────────────────────────────

/**
 * Provides the agent presence subscribe runtime value.
 * @param params Request payload to process.
 * @returns The agent presence subscribe result.
 */
export const agentPresenceSubscribe: ServerHandler<
  typeof agentPresenceSubscribeDefinition
> = (params) =>
  Effect.gen(function* () {
    const subscribedIds = yield* visiblePresenceAgentIds(
      params.agentIds,
      yield* agentArm,
    );
    return yield* presenceSnapshot(subscribedIds);
  }).pipe(Effect.withSpan("agentPresenceSubscribe"));

/**
 * Provides the app presence subscribe runtime value.
 * @param params Request payload to process.
 * @returns The app presence subscribe result.
 */
export const appPresenceSubscribe: ServerHandler<
  typeof appPresenceSubscribeDefinition
> = (params) =>
  Effect.gen(function* () {
    yield* appArm;
    return yield* presenceSnapshot(params.agentIds);
  }).pipe(Effect.withSpan("appPresenceSubscribe"));
