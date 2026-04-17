import type { PresenceService } from "../../services/presence.service.js";
import type { RpcMethodRegistry } from "../../rpc/context.js";
import { defineMethod } from "../../rpc/context.js";
import {
  PresenceUpdate,
  PresenceSubscribe,
  EventNames,
  eventFrame,
} from "@moltzap/protocol";
import { Effect } from "effect";
import type { ConnectionManager } from "../../ws/connection.js";
import { ConnIdTag } from "../layers.js";

export function createPresenceHandlers(deps: {
  presenceService: PresenceService;
  connections: ConnectionManager;
}): RpcMethodRegistry {
  return {
    "presence/update": defineMethod(PresenceUpdate, {
      requiresActive: true,
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const senderConnId = yield* ConnIdTag;
          deps.presenceService.update(ctx.agentId, params.status);

          const subscriberConnIds = deps.presenceService.getSubscribers(
            ctx.agentId,
          );
          const event = eventFrame(EventNames.PresenceChanged, {
            agentId: ctx.agentId,
            status: params.status,
          });
          const raw = JSON.stringify(event);
          for (const connId of subscriberConnIds) {
            if (connId === senderConnId) continue;
            const conn = deps.connections.get(connId);
            if (conn) {
              Effect.runFork(
                conn.write(raw).pipe(Effect.catchAll(() => Effect.void)),
              );
            }
          }
          return {};
        }),
    }),

    "presence/subscribe": defineMethod(PresenceSubscribe, {
      requiresActive: true,
      handler: (params) =>
        Effect.gen(function* () {
          const connId = yield* ConnIdTag;
          deps.presenceService.subscribe(connId, params.agentIds);
          const statuses = deps.presenceService.getMany(params.agentIds);
          return { statuses };
        }),
    }),
  };
}
