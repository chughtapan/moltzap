import type { ServerRpcSlots } from "../../transport/context.js";
import type { AgentContext } from "../../transport/context.js";
import { defineTaskMethod } from "../../transport/define-layered-method.js";
import {
  PresenceSubscribe,
  PresenceSubscribeAuth,
  NotInContactsError,
  type ParamsOf,
} from "@moltzap/protocol";
import type { AgentId as ServerAgentId } from "../../app/types.js";
import { Effect } from "effect";
import { ConnectionTag, DbTag, PresenceServiceTag } from "../../app/layers.js";
import { visibleAgentIds } from "../../identity/services/agent-visibility.js";
import { agentArm, toWireError } from "../../app/native-handlers-runtime.js";

/**
 * `presence/subscribe` registers fan-out interest via
 * `PresenceService.subscribe` and reads the current status snapshot via
 * `PresenceService.statusMany`. Presence is server-derived from `LeaseRegistry`
 * lifecycle + WS connect/disconnect; there is no client-driven
 * `presence/update`.
 *
 * Contact-scoped: throw NotInContactsError when any requested agentId falls
 * outside the caller's visibility set.
 */
function presenceSubscribeBody(
  params: ParamsOf<typeof PresenceSubscribe>,
  ctx: AgentContext,
) {
  return Effect.gen(function* () {
    const presenceService = yield* PresenceServiceTag;
    const db = yield* DbTag;
    const connection = yield* ConnectionTag;
    const requested = params.agentIds as ServerAgentId[];
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
    presenceService.subscribe(connection.connId, visibleIds);
    // The status snapshot is a ReadonlyArray; the wire schema expects a mutable
    // Array, so map to a fresh array (point-in-time copy).
    const projected = yield* presenceService.statusMany(visibleIds);
    const statuses = projected.map((entry) => ({
      agentId: entry.agentId,
      status: entry.status,
    }));
    return { statuses };
  }).pipe(Effect.withSpan("presence.subscribe"));
}

export const presenceHandlers: ServerRpcSlots = [
  defineTaskMethod(PresenceSubscribe, {
    callablePrincipal: "agent",
    requiresActive: true,
    handler: presenceSubscribeBody,
  }),
];

// ── Native @effect/rpc handler body ─────────────────────────────────────────

export const nativePresenceSubscribe = (
  params: ParamsOf<typeof PresenceSubscribe>,
) =>
  Effect.gen(function* () {
    yield* PresenceSubscribeAuth;
    return yield* presenceSubscribeBody(params, yield* agentArm);
  }).pipe(
    Effect.withSpan("nativePresenceSubscribe"),
    Effect.mapError(toWireError),
  );
