import {
  validators,
  EventNames,
  ErrorCodes,
  eventFrame,
} from "@moltzap/protocol";
import { ParticipantService } from "../../src/services/participant.service.js";
import { RpcError } from "../../src/rpc/router.js";
import { defineMethod } from "../../src/rpc/context.js";
export function createConversationHandlers(deps) {
  return {
    "conversations/create": defineMethod({
      validator: validators.conversationsCreateParams,
      handler: async (params, ctx) => {
        let creatorRef;
        if (ctx.kind === "user") {
          // Humans can only create a control-channel DM with their own active agent
          if (!ctx.activeAgentId) {
            throw new RpcError(
              ErrorCodes.Forbidden,
              "No active agent. Claim an agent first.",
            );
          }
          const isControlCreate =
            params.type === "dm" &&
            params.participants.length === 1 &&
            params.participants[0].type === "agent" &&
            params.participants[0].id === ctx.activeAgentId;
          if (!isControlCreate) {
            throw new RpcError(
              ErrorCodes.Forbidden,
              "Humans observe agent conversations. Use OpenClaw to instruct your agent.",
            );
          }
          // Bypass refFromContext — creator is the user, not their agent
          creatorRef = { type: "user", id: ctx.userId };
        } else {
          creatorRef = ParticipantService.refFromContext(ctx);
        }
        const conversation = await deps.conversationService.create(
          params.type,
          params.name,
          params.participants,
          creatorRef,
        );
        // Subscribe creator's connection to the new conversation
        const creatorConnId = deps.getConnId();
        const creatorConn = deps.connections.get(creatorConnId);
        if (creatorConn) {
          creatorConn.conversationIds.add(conversation.id);
        }
        // Notify all other participants and subscribe their connections
        for (const ref of params.participants) {
          // Subscribe any connected participant to the new conversation
          for (const conn of deps.connections.getByParticipant(
            ref.type,
            ref.id,
          )) {
            conn.conversationIds.add(conversation.id);
          }
          deps.broadcaster.sendToParticipant(
            ref.type,
            ref.id,
            eventFrame(EventNames.ConversationCreated, { conversation }),
          );
        }
        return { conversation };
      },
      requiresActive: true,
    }),
    "conversations/list": defineMethod({
      validator: validators.conversationsListParams,
      handler: async (params, ctx) => {
        const ref = ParticipantService.refFromContext(ctx);
        return deps.conversationService.list(ref, params.limit, params.cursor);
      },
      requiresActive: true,
    }),
    "conversations/get": defineMethod({
      validator: validators.conversationsGetParams,
      handler: async (params, ctx) => {
        const ref = ParticipantService.refFromContext(ctx);
        return deps.conversationService.get(params.conversationId, ref);
      },
      requiresActive: true,
    }),
    "conversations/update": defineMethod({
      validator: validators.conversationsUpdateParams,
      handler: async (params, ctx) => {
        if (ctx.kind === "user") {
          throw new RpcError(
            ErrorCodes.Forbidden,
            "Humans observe agent conversations. Use OpenClaw to instruct your agent.",
          );
        }
        const ref = ParticipantService.refFromContext(ctx);
        const conversation = await deps.conversationService.update(
          params.conversationId,
          params.name,
          ref,
        );
        deps.broadcaster.broadcastToConversation(
          params.conversationId,
          eventFrame(EventNames.ConversationUpdated, { conversation }),
        );
        return { conversation };
      },
      requiresActive: true,
    }),
    "conversations/leave": defineMethod({
      validator: validators.conversationsLeaveParams,
      handler: async (params, ctx) => {
        if (ctx.kind === "user") {
          throw new RpcError(
            ErrorCodes.Forbidden,
            "Humans observe agent conversations. Use OpenClaw to instruct your agent.",
          );
        }
        const ref = ParticipantService.refFromContext(ctx);
        await deps.conversationService.leave(params.conversationId, ref);
        // Remove conversation from connection's subscription set so broadcaster stops sending events
        const conn = deps.connections.get(deps.getConnId());
        if (conn) {
          conn.conversationIds.delete(params.conversationId);
        }
        return {};
      },
      requiresActive: true,
    }),
    "conversations/mute": defineMethod({
      validator: validators.conversationsMuteParams,
      handler: async (params, ctx) => {
        if (ctx.kind === "user") {
          throw new RpcError(
            ErrorCodes.Forbidden,
            "Humans observe agent conversations. Use OpenClaw to instruct your agent.",
          );
        }
        const ref = ParticipantService.refFromContext(ctx);
        await deps.conversationService.mute(
          params.conversationId,
          ref,
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
    "conversations/unmute": defineMethod({
      validator: validators.conversationsUnmuteParams,
      handler: async (params, ctx) => {
        if (ctx.kind === "user") {
          throw new RpcError(
            ErrorCodes.Forbidden,
            "Humans observe agent conversations. Use OpenClaw to instruct your agent.",
          );
        }
        const ref = ParticipantService.refFromContext(ctx);
        await deps.conversationService.unmute(params.conversationId, ref);
        // Update the mute cache on the caller's connection
        const conn = deps.connections.get(deps.getConnId());
        if (conn) {
          conn.mutedConversations.delete(params.conversationId);
        }
        return {};
      },
      requiresActive: true,
    }),
    "conversations/addParticipant": defineMethod({
      validator: validators.conversationsAddParticipantParams,
      handler: async (params, ctx) => {
        if (ctx.kind === "user") {
          throw new RpcError(
            ErrorCodes.Forbidden,
            "Humans observe agent conversations. Use OpenClaw to instruct your agent.",
          );
        }
        const ref = ParticipantService.refFromContext(ctx);
        const participant = await deps.conversationService.addParticipant(
          params.conversationId,
          params.participant,
          ref,
        );
        // Subscribe the new participant's connections to the conversation
        for (const conn of deps.connections.getByParticipant(
          params.participant.type,
          params.participant.id,
        )) {
          conn.conversationIds.add(params.conversationId);
        }
        return { participant };
      },
      requiresActive: true,
    }),
    "conversations/removeParticipant": defineMethod({
      validator: validators.conversationsRemoveParticipantParams,
      handler: async (params, ctx) => {
        if (ctx.kind === "user") {
          throw new RpcError(
            ErrorCodes.Forbidden,
            "Humans observe agent conversations. Use OpenClaw to instruct your agent.",
          );
        }
        const ref = ParticipantService.refFromContext(ctx);
        await deps.conversationService.removeParticipant(
          params.conversationId,
          params.participant,
          ref,
        );
        return {};
      },
      requiresActive: true,
    }),
  };
}
//# sourceMappingURL=conversations.handlers.js.map
