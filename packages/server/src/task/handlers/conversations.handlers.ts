import type { RpcMethodRegistry } from "../../transport/context.js";
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
} from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import { Effect } from "effect";
import { defineTaskMethod } from "../../transport/define-layered-method.js";
import {
  ConnIdTag,
  ConnectionManagerTag,
  ConversationServiceTag,
  TaskServiceTag,
} from "../../app/layers.js";
import {
  AddParticipantPermission,
  ConversationCreateAuthorization,
  ConversationParticipantAccess,
  obtainAddParticipantPermission,
  obtainConversationCreateAuthorization,
  obtainConversationParticipantAccess,
} from "../../app/capabilities/index.js";
import {
  broadcastNotificationToAgents,
  broadcastNotificationToConversation,
} from "./notification-broadcast.js";

/**
 * Spec D1 (#598) Contract decision — emit a deprecation log at every
 * legacy `Conversations*` handler entry, before the authority check.
 * Spec D3 (#600) deletes the legacy handlers (and these emissions)
 * alongside the legacy descriptors inside the same orchestration. The
 * warning carries the deprecated wire-method name and the suggested
 * replacement call so operators correlate log lines with migration
 * targets.
 *
 * Fires once per call. No throttling — the per-call shape is the spec
 * acceptance criterion ("a unit test asserts the warning fires").
 */
function logLegacyDeprecation(
  deprecated: string,
  replaceWith: string,
): Effect.Effect<void> {
  return Effect.logWarning(
    `[deprecated] ${deprecated} — replace with ${replaceWith}`,
  ).pipe(Effect.annotateLogs({ deprecated, replaceWith }));
}

export const conversationHandlers: RpcMethodRegistry = [
  defineTaskMethod(ConversationsCreate, {
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        yield* logLegacyDeprecation(
          "ConversationsCreate",
          "TaskCreate({ appId: DEFAULT_APP_ID, invitedAgentIds, initialConversation: {...} })",
        );
        const conversationService = yield* ConversationServiceTag;
        const taskService = yield* TaskServiceTag;
        const agentIds = params.participants.map((p) => p.id as AgentId);
        // Pass the task source as a lazy Effect so
        // `ConversationService.create` only mints when its DM dedup
        // misses; the `ConversationCreateAuthorization` composite's
        // `ExistingDm` short-circuit reaches the service body before
        // `input.mintTask` is yielded.
        const conversation = yield* conversationService
          .create({
            type: params.type,
            name: params.name,
            agentIds,
            creatorAgentId: ctx.agentId,
            mintTask: taskService.createDefaultTaskForType(
              params.type,
              ctx.agentId,
            ),
          })
          .pipe(
            Effect.provideServiceEffect(
              ConversationCreateAuthorization,
              obtainConversationCreateAuthorization({
                type: params.type,
                agentIds,
                creatorAgentId: ctx.agentId,
              }),
            ),
          );

        // `ConversationService.create` subscribes every participant's
        // open sockets to the new conversation; this handler fans the
        // ConversationCreated event so clients update their lists.
        yield* broadcastNotificationToAgents(
          agentIds,
          ConversationCreatedNotificationDefinition,
          { conversation },
        );

        return { conversation };
      }).pipe(Effect.withSpan("conversations.create")),
  }),
  defineTaskMethod(ConversationsList, {
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        yield* logLegacyDeprecation(
          "ConversationsList",
          "TaskConversationList({ limit?, cursor? })",
        );
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
        yield* logLegacyDeprecation(
          "ConversationsGet",
          "TaskConversationList + client-side filter (no Get equivalent)",
        );
        const conversationService = yield* ConversationServiceTag;
        return yield* conversationService
          .get(params.conversationId, ctx.agentId)
          .pipe(
            Effect.provideServiceEffect(
              ConversationParticipantAccess,
              obtainConversationParticipantAccess(
                params.conversationId,
                ctx.agentId,
              ),
            ),
          );
      }).pipe(Effect.withSpan("conversations.get")),
  }),
  defineTaskMethod(ConversationsUpdate, {
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        yield* logLegacyDeprecation(
          "ConversationsUpdate",
          "no replacement (conversation naming is set-at-create-time only)",
        );
        const conversationService = yield* ConversationServiceTag;
        const conversation = yield* conversationService.update(
          params.conversationId,
          params.name,
          ctx.agentId,
        );

        yield* broadcastNotificationToConversation(
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
        yield* logLegacyDeprecation(
          "ConversationsLeave",
          "TaskLeave({ taskId })",
        );
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
        yield* logLegacyDeprecation(
          "ConversationsArchive",
          "TaskConversationArchive({ taskId, conversationId })",
        );
        const conversationService = yield* ConversationServiceTag;
        const { archivedAt } = yield* conversationService.archive(
          params.conversationId,
          ctx.agentId,
        );
        yield* broadcastNotificationToConversation(
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
        yield* logLegacyDeprecation(
          "ConversationsUnarchive",
          "TaskConversationUnarchive({ taskId, conversationId })",
        );
        const conversationService = yield* ConversationServiceTag;
        yield* conversationService.unarchive(
          params.conversationId,
          ctx.agentId,
        );
        yield* broadcastNotificationToConversation(
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
        yield* logLegacyDeprecation(
          "ConversationsMute",
          "no replacement (mute is a client-local concern; mute retires in D3)",
        );
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
        yield* logLegacyDeprecation(
          "ConversationsUnmute",
          "no replacement (mute is a client-local concern; mute retires in D3)",
        );
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
        yield* logLegacyDeprecation(
          "ConversationsAddParticipant",
          "TaskConversationAddParticipant({ taskId, conversationId, agentId })",
        );
        const conversationService = yield* ConversationServiceTag;
        const targetAgentId = params.participant.id as AgentId;
        const participant = yield* conversationService
          .addParticipant(params.conversationId, targetAgentId, ctx.agentId)
          .pipe(
            Effect.provideServiceEffect(
              AddParticipantPermission,
              obtainAddParticipantPermission({
                conversationId: params.conversationId,
                requesterAgentId: ctx.agentId,
                targetAgentId,
              }),
            ),
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
        yield* logLegacyDeprecation(
          "ConversationsRemoveParticipant",
          "TaskConversationRemoveParticipant({ taskId, conversationId, agentId })",
        );
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
