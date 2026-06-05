import type { AgentContext, AppContext } from "../../transport/context.js";
import { PresenceSubscribe } from "@moltzap/protocol/network";
import { NotInContactsError } from "@moltzap/protocol/identity";
import type { ParamsOf } from "@moltzap/protocol/transport";
import type { ServerHandler } from "@moltzap/protocol/socket";
import type { AgentId } from "@moltzap/protocol/identity";
import { Effect } from "effect";
import {
  ConnectionManagerTag,
  ConnectionTag,
  DbTag,
  PresenceServiceTag,
} from "../../app/layers.js";
import { visibleAgentIds } from "../../identity/services/agent-visibility.js";
import { peekLiveArm } from "../../transport/principal-gate.js";

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

const authenticatedArm: Effect.Effect<
  AgentContext | AppContext,
  never,
  ConnectionTag | ConnectionManagerTag
> = Effect.gen(function* () {
  const snapshot = yield* ConnectionTag;
  const manager = yield* ConnectionManagerTag;
  const connection = yield* peekLiveArm(manager, snapshot.connId);
  if (
    connection._tag === "AgentConnection" ||
    connection._tag === "AppConnection"
  ) {
    return connection.auth;
  }
  return yield* Effect.dieMessage(
    `handler: authenticated method reached on ${connection._tag} arm`,
  );
}).pipe(Effect.withSpan("serverHandlers.authenticatedArm"));

export const presenceSubscribe: ServerHandler<typeof PresenceSubscribe> = (
  params,
) =>
  Effect.gen(function* () {
    return yield* presenceSubscribeBody(params, yield* authenticatedArm);
  }).pipe(Effect.withSpan("presenceSubscribe"));
