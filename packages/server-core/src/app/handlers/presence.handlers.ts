import type { PresenceService } from "../../services/presence.service.js";
import type { ConversationService } from "../../services/conversation.service.js";
import type { RpcMethodRegistry } from "../../rpc/context.js";
import { defineMethod } from "../../rpc/context.js";
import type {
  PresenceUpdateParams,
  PresenceSubscribeParams,
} from "@moltzap/protocol";
import { validators, EventNames, eventFrame } from "@moltzap/protocol";
import { ParticipantService } from "../../services/participant.service.js";
import type { Broadcaster } from "../../ws/broadcaster.js";
import type { ConnectionManager } from "../../ws/connection.js";

export function createPresenceHandlers(deps: {
  presenceService: PresenceService;
  conversationService: ConversationService;
  broadcaster: Broadcaster;
  connections: ConnectionManager;
  getConnId: () => string;
}): RpcMethodRegistry {
  return {
    "presence/update": defineMethod<PresenceUpdateParams>({
      validator: validators.presenceUpdateParams,
      requiresActive: true,
      handler: async (params, ctx) => {
        const ref = ParticipantService.refFromContext(ctx);
        deps.presenceService.update(ref, params.status);

        // Notify only connections that subscribed to this participant
        const subscriberConnIds = deps.presenceService.getSubscribers(ref);
        const event = eventFrame(EventNames.PresenceChanged, {
          participant: ref,
          status: params.status,
        });
        const raw = JSON.stringify(event);
        const senderConnId = deps.getConnId();
        for (const connId of subscriberConnIds) {
          if (connId === senderConnId) continue;
          const conn = deps.connections.get(connId);
          if (conn) {
            conn.ws.send(raw);
          }
        }

        return {};
      },
    }),

    "presence/subscribe": defineMethod<PresenceSubscribeParams>({
      validator: validators.presenceSubscribeParams,
      requiresActive: true,
      handler: async (params, _ctx) => {
        const connId = deps.getConnId();
        deps.presenceService.subscribe(connId, params.participants);
        const statuses = deps.presenceService.getMany(params.participants);
        return { statuses };
      },
    }),
  };
}
