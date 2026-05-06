import type { ConversationService } from "../../services/conversation.service.js";
import type { TaskService } from "../../services/task.service.js";
import type { ConnectionManager } from "../../ws/connection.js";
import type { NetworkSendService } from "../../network/network-send.js";
import { opaquePayload } from "../../network/network-send.js";
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
  type NotificationDefinition,
  type NotificationParamsOf,
  type TSchema,
} from "@moltzap/protocol";
import { agentId as makeAgentId } from "@moltzap/protocol/network";
import { Effect } from "effect";
import { defineTaskMethod } from "../../rpc/define-layered-method.js";
import { ConnIdTag } from "../../app/layers.js";

export function createConversationHandlers(deps: {
  conversationService: ConversationService;
  taskService: TaskService;
  networkSendService: NetworkSendService;
  connections: ConnectionManager;
}): RpcMethodRegistry {
  const broadcastToConversation = <
    D extends NotificationDefinition<string, TSchema>,
  >(
    conversationId: string,
    definition: D,
    params: NotificationParamsOf<D>,
  ): Effect.Effect<void, never> =>
    Effect.gen(function* () {
      const participants = yield* deps.conversationService
        .getParticipantAgentIds(conversationId)
        .pipe(Effect.orElseSucceed(() => [] as readonly string[]));
      if (participants.length === 0) return;
      const frame = notificationFrame(definition, params);
      const payload = opaquePayload(JSON.stringify(frame));
      yield* deps.networkSendService.broadcast(
        participants.map((id) => makeAgentId(id)),
        payload,
        { forConversation: conversationId },
      );
    });

  return [
    defineTaskMethod(ConversationsCreate, {
      requiresActive: true,
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const agentIds = params.participants.map((p) => p.id);
          // Pass the task source as a lazy Effect so
          // `ConversationService.create` only mints when its DM dedup
          // misses; pre-fix every duplicate-DM call orphaned a task.
          const conversation = yield* deps.conversationService.create(
            params.type,
            params.name,
            agentIds,
            ctx.agentId,
            deps.taskService.createDefaultTaskForType(params.type, ctx.agentId),
          );

          // `ConversationService.create` subscribes every participant's
          // open sockets to the new conversation; this handler fans the
          // ConversationCreated event so clients update their lists.
          const createdFrame = notificationFrame(
            ConversationCreatedNotificationDefinition,
            { conversation },
          );
          const createdPayload = opaquePayload(JSON.stringify(createdFrame));
          yield* deps.networkSendService.broadcast(
            params.participants.map((p) => makeAgentId(p.id)),
            createdPayload,
          );

          return { conversation };
        }),
    }),
    defineTaskMethod(ConversationsList, {
      requiresActive: true,
      handler: (params, ctx) =>
        deps.conversationService.list(
          ctx.agentId,
          params.limit,
          params.cursor,
          params.archived,
        ),
    }),
    defineTaskMethod(ConversationsGet, {
      requiresActive: true,
      handler: (params, ctx) =>
        deps.conversationService.get(params.conversationId, ctx.agentId),
    }),
    defineTaskMethod(ConversationsUpdate, {
      requiresActive: true,
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const conversation = yield* deps.conversationService.update(
            params.conversationId,
            params.name,
            ctx.agentId,
          );

          yield* broadcastToConversation(
            params.conversationId,
            ConversationUpdatedNotificationDefinition,
            { conversation },
          );

          return { conversation };
        }),
    }),
    defineTaskMethod(ConversationsLeave, {
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
    defineTaskMethod(ConversationsArchive, {
      requiresActive: true,
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const { archivedAt } = yield* deps.conversationService.archive(
            params.conversationId,
            ctx.agentId,
          );
          yield* broadcastToConversation(
            params.conversationId,
            ConversationArchivedNotificationDefinition,
            {
              conversationId: params.conversationId,
              archivedAt,
              by: ctx.agentId,
            },
          );
          return {};
        }),
    }),
    defineTaskMethod(ConversationsUnarchive, {
      requiresActive: true,
      handler: (params, ctx) =>
        Effect.gen(function* () {
          yield* deps.conversationService.unarchive(
            params.conversationId,
            ctx.agentId,
          );
          yield* broadcastToConversation(
            params.conversationId,
            ConversationUnarchivedNotificationDefinition,
            {
              conversationId: params.conversationId,
              by: ctx.agentId,
            },
          );
          return {};
        }),
    }),
    defineTaskMethod(ConversationsMute, {
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
    defineTaskMethod(ConversationsUnmute, {
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

    defineTaskMethod(ConversationsAddParticipant, {
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

    defineTaskMethod(ConversationsRemoveParticipant, {
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
