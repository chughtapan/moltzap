import { defineMethod } from "../../src/rpc/context.js";
import { validators, EventNames, eventFrame } from "@moltzap/protocol";
import { ParticipantService } from "../../src/services/participant.service.js";
export function createPresenceHandlers(deps) {
    return {
        "presence/update": defineMethod({
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
                    if (connId === senderConnId)
                        continue;
                    const conn = deps.connections.get(connId);
                    if (conn) {
                        conn.ws.send(raw);
                    }
                }
                return {};
            },
        }),
        "presence/subscribe": defineMethod({
            validator: validators.presenceSubscribeParams,
            requiresActive: true,
            handler: async (params, _ctx) => {
                const connId = deps.getConnId();
                deps.presenceService.subscribe(connId, params.participants);
                const statuses = deps.presenceService.getMany(params.participants);
                return { statuses };
            },
        }),
        "typing/send": defineMethod({
            validator: validators.typingSendParams,
            requiresActive: true,
            handler: async (params, ctx) => {
                const senderRef = ParticipantService.refFromContext(ctx);
                await deps.conversationService.requireParticipant(params.conversationId, senderRef);
                deps.broadcaster.broadcastToConversation(params.conversationId, eventFrame(EventNames.TypingIndicator, {
                    conversationId: params.conversationId,
                    participant: senderRef,
                }), deps.getConnId());
                return {};
            },
        }),
    };
}
//# sourceMappingURL=presence.handlers.js.map