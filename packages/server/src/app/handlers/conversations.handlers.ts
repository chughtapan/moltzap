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
  EventNames,
  eventFrame,
} from "@moltzap/protocol";
import { Effect } from "effect";
import { defineMethod } from "../../rpc/context.js";
import { ConnIdTag } from "../layers.js";

export function createConversationHandlers(deps: {
  conversationService: ConversationService;
  broadcaster: Broadcaster;
  connections: ConnectionManager;
}): RpcMethodRegistry {
  return {
    "conversations/create": defineMethod(ConversationsCreate, {
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
              eventFrame(EventNames.ConversationCreated, { conversation }),
            );
          }

          return { conversation };
        }),
    }),

    "conversations/list": defineMethod(ConversationsList, {
      requiresActive: true,
      handler: (params, ctx) =>
        deps.conversationService.list(
          ctx.agentId,
          params.limit,
          params.cursor,
          params.archived,
        ),
    }),

    "conversations/get": defineMethod(ConversationsGet, {
      requiresActive: true,
      handler: (params, ctx) =>
        deps.conversationService.get(params.conversationId, ctx.agentId),
    }),

    "conversations/update": defineMethod(ConversationsUpdate, {
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
            eventFrame(EventNames.ConversationUpdated, { conversation }),
          );

          return { conversation };
        }),
    }),

    "conversations/leave": defineMethod(ConversationsLeave, {
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

    "conversations/archive": defineMethod(ConversationsArchive, {
      requiresActive: true,
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const { archivedAt } = yield* deps.conversationService.archive(
            params.conversationId,
            ctx.agentId,
          );
          deps.broadcaster.broadcastToConversation(
            params.conversationId,
            eventFrame(EventNames.ConversationArchived, {
              conversationId: params.conversationId,
              archivedAt,
              by: ctx.agentId,
            }),
          );
          return {};
        }),
    }),

    "conversations/unarchive": defineMethod(ConversationsUnarchive, {
      requiresActive: true,
      handler: (params, ctx) =>
        Effect.gen(function* () {
          yield* deps.conversationService.unarchive(
            params.conversationId,
            ctx.agentId,
          );
          deps.broadcaster.broadcastToConversation(
            params.conversationId,
            eventFrame(EventNames.ConversationUnarchived, {
              conversationId: params.conversationId,
              by: ctx.agentId,
            }),
          );
          return {};
        }),
    }),

    "conversations/mute": defineMethod(ConversationsMute, {
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

    "conversations/unmute": defineMethod(ConversationsUnmute, {
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

    "conversations/addParticipant": defineMethod(ConversationsAddParticipant, {
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

    "conversations/removeParticipant": defineMethod(
      ConversationsRemoveParticipant,
      {
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
      },
    ),
  };
}
