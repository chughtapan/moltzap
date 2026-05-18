import type { RpcMethodRegistry } from "../../transport/context.js";
import { opaquePayload } from "../../network/network-send.js";
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
  type NotificationDefinition,
  type NotificationParamsOf,
} from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/task";
import { Effect } from "effect";
import { defineTaskMethod } from "../../transport/define-layered-method.js";
import {
  ConnIdTag,
  ConnectionManagerTag,
  ConversationServiceTag,
  NetworkSendServiceTag,
  TaskServiceTag,
} from "../../app/layers.js";

const broadcastToConversation = <D extends NotificationDefinition<string, any>>(
  conversationId: ConversationId,
  definition: D,
  params: NotificationParamsOf<D>,
): Effect.Effect<void, never, ConversationServiceTag | NetworkSendServiceTag> =>
  Effect.gen(function* () {
    const conversationService = yield* ConversationServiceTag;
    const networkSendService = yield* NetworkSendServiceTag;
    const participants = yield* conversationService
      .getParticipantAgentIds(conversationId)
      .pipe(Effect.orElseSucceed(() => [] as readonly AgentId[]));
    if (participants.length === 0) return;
    const frame = definition.encode(params);
    const payload = opaquePayload(JSON.stringify(frame));
    yield* networkSendService.broadcast(participants, payload, {
      forConversation: conversationId,
    });
  }).pipe(Effect.withSpan("conversations.broadcast"));

export const conversationHandlers: RpcMethodRegistry = [
  defineTaskMethod(ConversationsCreate, {
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const conversationService = yield* ConversationServiceTag;
        const taskService = yield* TaskServiceTag;
        const networkSendService = yield* NetworkSendServiceTag;
        const agentIds = params.participants.map((p) => p.id as AgentId);
        // Pass the task source as a lazy Effect so
        // `ConversationService.create` only mints when its DM dedup
        // misses; pre-fix every duplicate-DM call orphaned a task.
        const conversation = yield* conversationService.create(
          params.type,
          params.name,
          agentIds,
          ctx.agentId,
          taskService.createDefaultTaskForType(params.type, ctx.agentId),
        );

        // `ConversationService.create` subscribes every participant's
        // open sockets to the new conversation; this handler fans the
        // ConversationCreated event so clients update their lists.
        const createdFrame = ConversationCreatedNotificationDefinition.encode({
          conversation,
        });
        const createdPayload = opaquePayload(JSON.stringify(createdFrame));
        yield* networkSendService.broadcast(agentIds, createdPayload);

        return { conversation };
      }).pipe(Effect.withSpan("conversations.create")),
  }),
  defineTaskMethod(ConversationsList, {
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const conversationService = yield* ConversationServiceTag;
        return yield* conversationService.list(
          ctx.agentId,
          params.limit,
          params.cursor,
          params.archived,
        );
      }).pipe(Effect.withSpan("conversations.list")),
  }),
  defineTaskMethod(ConversationsGet, {
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const conversationService = yield* ConversationServiceTag;
        return yield* conversationService.get(
          params.conversationId,
          ctx.agentId,
        );
      }).pipe(Effect.withSpan("conversations.get")),
  }),
  defineTaskMethod(ConversationsUpdate, {
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const conversationService = yield* ConversationServiceTag;
        const conversation = yield* conversationService.update(
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
      }).pipe(Effect.withSpan("conversations.update")),
  }),
  defineTaskMethod(ConversationsLeave, {
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const conversationService = yield* ConversationServiceTag;
        const connections = yield* ConnectionManagerTag;
        yield* conversationService.leave(params.conversationId, ctx.agentId);
        const connId = yield* ConnIdTag;
        const conn = connections.get(connId);
        if (conn) {
          conn.conversationIds.delete(params.conversationId);
        }
        return {};
      }).pipe(Effect.withSpan("conversations.leave")),
  }),
  defineTaskMethod(ConversationsArchive, {
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const conversationService = yield* ConversationServiceTag;
        const { archivedAt } = yield* conversationService.archive(
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
      }).pipe(Effect.withSpan("conversations.archive")),
  }),
  defineTaskMethod(ConversationsUnarchive, {
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const conversationService = yield* ConversationServiceTag;
        yield* conversationService.unarchive(
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
      }).pipe(Effect.withSpan("conversations.unarchive")),
  }),
  defineTaskMethod(ConversationsMute, {
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const conversationService = yield* ConversationServiceTag;
        const connections = yield* ConnectionManagerTag;
        yield* conversationService.mute(
          params.conversationId,
          ctx.agentId,
          params.until,
        );
        const connId = yield* ConnIdTag;
        const conn = connections.get(connId);
        if (conn) {
          conn.mutedConversations.add(params.conversationId);
        }
        return {};
      }).pipe(Effect.withSpan("conversations.mute")),
  }),
  defineTaskMethod(ConversationsUnmute, {
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const conversationService = yield* ConversationServiceTag;
        const connections = yield* ConnectionManagerTag;
        yield* conversationService.unmute(params.conversationId, ctx.agentId);
        const connId = yield* ConnIdTag;
        const conn = connections.get(connId);
        if (conn) {
          conn.mutedConversations.delete(params.conversationId);
        }
        return {};
      }).pipe(Effect.withSpan("conversations.unmute")),
  }),

  defineTaskMethod(ConversationsAddParticipant, {
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const conversationService = yield* ConversationServiceTag;
        const targetAgentId = params.participant.id as AgentId;
        const participant = yield* conversationService.addParticipant(
          params.conversationId,
          targetAgentId,
          ctx.agentId,
        );
        // Per architect plan §2 module 7: the redundant
        // `getByAgent(...)` subscription loop dropped — the service
        // already calls `subscribeAgentsToConversation` in
        // `addParticipant`, so the handler-side loop was dead.
        return { participant };
      }).pipe(Effect.withSpan("conversations.addParticipant")),
  }),

  defineTaskMethod(ConversationsRemoveParticipant, {
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const conversationService = yield* ConversationServiceTag;
        yield* conversationService.removeParticipant(
          params.conversationId,
          params.participant.id as AgentId,
          ctx.agentId,
        );
        return {};
      }).pipe(Effect.withSpan("conversations.removeParticipant")),
  }),
];
