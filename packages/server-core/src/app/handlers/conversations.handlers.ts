import type { ConversationService } from "../../services/conversation.service.js";
import type { Broadcaster } from "../../ws/broadcaster.js";
import type { ConnectionManager } from "../../ws/connection.js";
import type { RpcMethodRegistry } from "../../rpc/context.js";
import type {
  ConversationsCreateParams,
  ConversationsListParams,
  ConversationsGetParams,
  ConversationsUpdateParams,
  ConversationsLeaveParams,
  ConversationsMuteParams,
  ConversationsUnmuteParams,
  ConversationsAddParticipantParams,
  ConversationsRemoveParticipantParams,
} from "@moltzap/protocol";
import { validators, EventNames, eventFrame } from "@moltzap/protocol";
import { defineMethod } from "../../rpc/context.js";

export function createConversationHandlers(deps: {
  conversationService: ConversationService;
  broadcaster: Broadcaster;
  connections: ConnectionManager;
  getConnId: () => string;
}): RpcMethodRegistry {
  return {
    "conversations/create": defineMethod<ConversationsCreateParams>({
      validator: validators.conversationsCreateParams,
      handler: async (params, ctx) => {
        const agentIds = params.participants.map((p) => p.id);
        const conversation = await deps.conversationService.create(
          params.type,
          params.name,
          agentIds,
          ctx.agentId,
        );

        // Subscribe creator's connection to the new conversation
        const creatorConnId = deps.getConnId();
        const creatorConn = deps.connections.get(creatorConnId);
        if (creatorConn) {
          creatorConn.conversationIds.add(conversation.id);
        }

        // Notify all other participants and subscribe their connections
        for (const participant of params.participants) {
          // Subscribe any connected participant to the new conversation
          for (const conn of deps.connections.getByAgent(participant.id)) {
            conn.conversationIds.add(conversation.id);
          }
          deps.broadcaster.sendToAgent(
            participant.id,
            eventFrame(EventNames.ConversationCreated, { conversation }),
          );
        }

        return { conversation };
      },
      requiresActive: true,
    }),

    "conversations/list": defineMethod<ConversationsListParams>({
      validator: validators.conversationsListParams,
      handler: async (params, ctx) => {
        return deps.conversationService.list(
          ctx.agentId,
          params.limit,
          params.cursor,
        );
      },
      requiresActive: true,
    }),

    "conversations/get": defineMethod<ConversationsGetParams>({
      validator: validators.conversationsGetParams,
      handler: async (params, ctx) => {
        return deps.conversationService.get(params.conversationId, ctx.agentId);
      },
      requiresActive: true,
    }),

    "conversations/update": defineMethod<ConversationsUpdateParams>({
      validator: validators.conversationsUpdateParams,
      handler: async (params, ctx) => {
        const conversation = await deps.conversationService.update(
          params.conversationId,
          params.name,
          ctx.agentId,
        );

        deps.broadcaster.broadcastToConversation(
          params.conversationId,
          eventFrame(EventNames.ConversationUpdated, { conversation }),
        );

        return { conversation };
      },
      requiresActive: true,
    }),

    "conversations/leave": defineMethod<ConversationsLeaveParams>({
      validator: validators.conversationsLeaveParams,
      handler: async (params, ctx) => {
        await deps.conversationService.leave(
          params.conversationId,
          ctx.agentId,
        );

        // Remove conversation from connection's subscription set
        const conn = deps.connections.get(deps.getConnId());
        if (conn) {
          conn.conversationIds.delete(params.conversationId);
        }

        return {};
      },
      requiresActive: true,
    }),

    "conversations/mute": defineMethod<ConversationsMuteParams>({
      validator: validators.conversationsMuteParams,
      handler: async (params, ctx) => {
        await deps.conversationService.mute(
          params.conversationId,
          ctx.agentId,
          params.until,
        );

        // Update the mute cache on the caller's connection
        const conn = deps.connections.get(deps.getConnId());
        if (conn) {
          conn.mutedConversations.add(params.conversationId);
        }

        return {};
      },
      requiresActive: true,
    }),

    "conversations/unmute": defineMethod<ConversationsUnmuteParams>({
      validator: validators.conversationsUnmuteParams,
      handler: async (params, ctx) => {
        await deps.conversationService.unmute(
          params.conversationId,
          ctx.agentId,
        );

        // Update the mute cache on the caller's connection
        const conn = deps.connections.get(deps.getConnId());
        if (conn) {
          conn.mutedConversations.delete(params.conversationId);
        }

        return {};
      },
      requiresActive: true,
    }),

    "conversations/addParticipant":
      defineMethod<ConversationsAddParticipantParams>({
        validator: validators.conversationsAddParticipantParams,
        handler: async (params, ctx) => {
          const participant = await deps.conversationService.addParticipant(
            params.conversationId,
            params.participant.id,
            ctx.agentId,
          );
          // Subscribe the new participant's connections to the conversation
          for (const conn of deps.connections.getByAgent(
            params.participant.id,
          )) {
            conn.conversationIds.add(params.conversationId);
          }
          return { participant };
        },
        requiresActive: true,
      }),

    "conversations/removeParticipant":
      defineMethod<ConversationsRemoveParticipantParams>({
        validator: validators.conversationsRemoveParticipantParams,
        handler: async (params, ctx) => {
          await deps.conversationService.removeParticipant(
            params.conversationId,
            params.participant.id,
            ctx.agentId,
          );
          return {};
        },
        requiresActive: true,
      }),
  };
}
