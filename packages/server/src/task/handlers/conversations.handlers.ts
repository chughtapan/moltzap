import type { ConversationService } from "../../services/conversation.service.js";
import type { Broadcaster } from "../../ws/broadcaster.js";
import type { ConnectionManager } from "../../ws/connection.js";
import type { RpcMethodRegistry } from "../../rpc/context.js";
import {
  ConversationsCreate,
  ConversationsList,
  ConversationsGet,
  ConversationsUpdate,
  ConversationsLeave,
  ConversationsMute,
  ConversationsUnmute,
  ConversationsAddParticipant,
  ConversationsRemoveParticipant,
  ConversationsArchive,
  ConversationsUnarchive,
  ConversationArchivedNotificationDefinition,
  ConversationCreatedNotificationDefinition,
  ConversationUnarchivedNotificationDefinition,
  ConversationUpdatedNotificationDefinition,
  notificationFrame,
} from "@moltzap/protocol";
import { Effect } from "effect";
import { defineMethod } from "../../rpc/context.js";
import { ConnIdTag } from "../../app/layers.js";

export function createConversationHandlers(deps: {
  conversationService: ConversationService;
  broadcaster: Broadcaster;
  connections: ConnectionManager;
}): RpcMethodRegistry {
  return [
    defineMethod(ConversationsCreate, {
      requiresActive: true,
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const agentIds = params.participants.map((p) => p.id);
          const conversation = yield* deps.conversationService.create(
            params.type,
            params.name,
            agentIds,
            ctx.agentId,
          );

          // ConversationService.create subscribes every participant's open
          // sockets (including the creator's) to the new conversation. The
          // handler's only remaining job is to fan the ConversationCreated
          // event out to each participant's agent so clients can react to
          // the new conversation appearing in their conversation list.
          for (const participant of params.participants) {
            deps.broadcaster.sendToAgent(
              participant.id,
              notificationFrame(ConversationCreatedNotificationDefinition, {
                conversation,
              }),
            );
          }

          return { conversation };
        }),
    }),
    defineMethod(ConversationsList, {
      requiresActive: true,
      handler: (params, ctx) =>
        deps.conversationService.list(
          ctx.agentId,
          params.limit,
          params.cursor,
          params.archived,
        ),
    }),
    defineMethod(ConversationsGet, {
      requiresActive: true,
      handler: (params, ctx) =>
        deps.conversationService.get(params.conversationId, ctx.agentId),
    }),
    defineMethod(ConversationsUpdate, {
      requiresActive: true,
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const conversation = yield* deps.conversationService.update(
            params.conversationId,
            params.name,
            ctx.agentId,
          );

          deps.broadcaster.broadcastToConversation(
            params.conversationId,
            notificationFrame(ConversationUpdatedNotificationDefinition, {
              conversation,
            }),
          );

          return { conversation };
        }),
    }),
    defineMethod(ConversationsLeave, {
      requiresActive: true,
      handler: (params, ctx) =>
        Effect.gen(function* () {
          yield* deps.conversationService.leave(
            params.conversationId,
            ctx.agentId,
          );
          const connId = yield* ConnIdTag;
          const conn = deps.connections.get(connId);
          if (conn) {
            conn.conversationIds.delete(params.conversationId);
          }
          return {};
        }),
    }),
    defineMethod(ConversationsArchive, {
      requiresActive: true,
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const { archivedAt } = yield* deps.conversationService.archive(
            params.conversationId,
            ctx.agentId,
          );
          deps.broadcaster.broadcastToConversation(
            params.conversationId,
            notificationFrame(ConversationArchivedNotificationDefinition, {
              conversationId: params.conversationId,
              archivedAt,
              by: ctx.agentId,
            }),
          );
          return {};
        }),
    }),
    defineMethod(ConversationsUnarchive, {
      requiresActive: true,
      handler: (params, ctx) =>
        Effect.gen(function* () {
          yield* deps.conversationService.unarchive(
            params.conversationId,
            ctx.agentId,
          );
          deps.broadcaster.broadcastToConversation(
            params.conversationId,
            notificationFrame(ConversationUnarchivedNotificationDefinition, {
              conversationId: params.conversationId,
              by: ctx.agentId,
            }),
          );
          return {};
        }),
    }),
    defineMethod(ConversationsMute, {
      requiresActive: true,
      handler: (params, ctx) =>
        Effect.gen(function* () {
          yield* deps.conversationService.mute(
            params.conversationId,
            ctx.agentId,
            params.until,
          );
          const connId = yield* ConnIdTag;
          const conn = deps.connections.get(connId);
          if (conn) {
            conn.mutedConversations.add(params.conversationId);
          }
          return {};
        }),
    }),
    defineMethod(ConversationsUnmute, {
      requiresActive: true,
      handler: (params, ctx) =>
        Effect.gen(function* () {
          yield* deps.conversationService.unmute(
            params.conversationId,
            ctx.agentId,
          );
          const connId = yield* ConnIdTag;
          const conn = deps.connections.get(connId);
          if (conn) {
            conn.mutedConversations.delete(params.conversationId);
          }
          return {};
        }),
    }),

    defineMethod(ConversationsAddParticipant, {
      requiresActive: true,
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const participant = yield* deps.conversationService.addParticipant(
            params.conversationId,
            params.participant.id,
            ctx.agentId,
          );
          for (const conn of deps.connections.getByAgent(
            params.participant.id,
          )) {
            conn.conversationIds.add(params.conversationId);
          }
          return { participant };
        }),
    }),

    defineMethod(ConversationsRemoveParticipant, {
      requiresActive: true,
      handler: (params, ctx) =>
        Effect.gen(function* () {
          yield* deps.conversationService.removeParticipant(
            params.conversationId,
            params.participant.id,
            ctx.agentId,
          );
          return {};
        }),
    }),
  ];
}
