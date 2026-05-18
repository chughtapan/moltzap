import { Effect } from "effect";
import {
  ConversationArchivedNotificationDefinition,
  TaskClosedNotificationDefinition,
  TasksAddParticipant,
  TasksClose,
  TasksCloseConversation,
  TasksCreate,
  TasksCreateConversation,
  TasksGet,
  TasksGetMessages,
  TasksGetMessagesSince,
  TasksList,
  TasksRemoveParticipant,
  TasksStoreMessage,
  type TmType,
} from "@moltzap/protocol";
import { InvalidParamsError } from "../../runtime/index.js";
import { type EndpointAddress } from "@moltzap/protocol/network";
import {
  DEFAULT_DM_TM_ADDRESS,
  DEFAULT_GROUP_TM_ADDRESS,
} from "../../network/app-tm-registry.js";
import { endpointAddressForAgent } from "../../task/services/task.service.js";
import { defineTaskMethod } from "../../transport/define-layered-method.js";
import type { RpcMethodRegistry } from "../../transport/context.js";
import type { AgentId } from "../../app/types.js";
import { TaskServiceTag } from "../../app/layers.js";
import { broadcastNotificationToAgents } from "./notification-broadcast.js";

/**
 * Phase 9b consumer-migration (sub-issue #460 round 4 R16, codex
 * HIGH-A): server-derived TM endpoint address. Pre-R16 the wire body
 * accepted a caller-supplied `tmEndpointAddress: string`, letting an
 * authenticated agent A bind a fresh task to a stranger B's TM and
 * dispatch messages to B's WS without B's consent. R16 replaces the
 * caller-supplied field with a `tmType` kind marker; the server
 * resolves the address from the kind + the authenticated caller, so
 * "self" always means the caller and the default kinds resolve to the
 * in-process default-TM constants.
 */
function deriveTmEndpointAddress(
  tmType: TmType,
  callerAgentId: AgentId,
): EndpointAddress {
  switch (tmType) {
    case "self":
      return endpointAddressForAgent(callerAgentId);
    case "default-dm":
      return DEFAULT_DM_TM_ADDRESS;
    case "default-group":
      return DEFAULT_GROUP_TM_ADDRESS;
    default: {
      const _absurd: never = tmType;
      return _absurd;
    }
  }
}

export const taskHandlers: RpcMethodRegistry = [
  defineTaskMethod(TasksCreate, {
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const taskService = yield* TaskServiceTag;
        // Prereq 2 (#525 §4d): app-bound tasks always carry their
        // own moderator (the TM IS the app), so pairing an `appId`
        // with a `default-*` TM kind is a nonsense shape. Reject at
        // the wire boundary with `InvalidParamsError` instead of
        // letting it through and silently routing dispatch to one
        // of the in-process default-TM constants.
        if (
          params.appId !== undefined &&
          (params.tmType === "default-dm" || params.tmType === "default-group")
        ) {
          return yield* Effect.fail(
            new InvalidParamsError({
              message: "app-bound tasks cannot use a default TM",
            }),
          );
        }
        const tmEndpointAddress = deriveTmEndpointAddress(
          params.tmType,
          ctx.agentId,
        );
        const task = yield* taskService.create(ctx.agentId, {
          appId: params.appId,
          invitedAgentIds: params.invitedAgentIds,
          tmEndpointAddress,
        });
        return { task };
      }).pipe(Effect.withSpan("tasks.create")),
  }),

  defineTaskMethod(TasksGet, {
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const taskService = yield* TaskServiceTag;
        return yield* taskService.get(params.taskId, ctx.agentId);
      }).pipe(Effect.withSpan("tasks.get")),
  }),

  defineTaskMethod(TasksList, {
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const taskService = yield* TaskServiceTag;
        const tasks = yield* taskService.list(ctx.agentId, {
          appId: params.appId,
          status: params.status,
          limit: params.limit,
        });
        return { tasks: [...tasks] };
      }).pipe(Effect.withSpan("tasks.list")),
  }),

  defineTaskMethod(TasksClose, {
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const taskService = yield* TaskServiceTag;
        const closed = yield* taskService.closeWithLifecycle(
          params.taskId,
          ctx.agentId,
        );
        for (const conversation of closed.archivedConversations) {
          yield* broadcastNotificationToAgents(
            conversation.participantAgentIds,
            ConversationArchivedNotificationDefinition,
            {
              conversationId: conversation.conversationId,
              archivedAt: conversation.archivedAt,
              by: ctx.agentId,
            },
            { forConversation: conversation.conversationId },
          );
        }
        yield* broadcastNotificationToAgents(
          closed.participantAgentIds,
          TaskClosedNotificationDefinition,
          { task: closed.task },
        );
        return { task: closed.task };
      }).pipe(Effect.withSpan("tasks.close")),
  }),

  defineTaskMethod(TasksCreateConversation, {
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const taskService = yield* TaskServiceTag;
        const conversation = yield* taskService.createConversation(
          params.taskId,
          ctx.agentId,
          {
            type: params.type,
            name: params.name,
            participantAgentIds: params.participants.map(
              (p) => p.id as AgentId,
            ),
          },
        );
        return { conversation };
      }).pipe(Effect.withSpan("tasks.createConversation")),
  }),

  defineTaskMethod(TasksCloseConversation, {
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const taskService = yield* TaskServiceTag;
        yield* taskService.closeConversation(
          params.taskId,
          ctx.agentId,
          params.conversationId,
        );
        return {};
      }).pipe(Effect.withSpan("tasks.closeConversation")),
  }),

  defineTaskMethod(TasksAddParticipant, {
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const taskService = yield* TaskServiceTag;
        const participant = yield* taskService.addParticipant(
          params.taskId,
          ctx.agentId,
          params.agentId,
        );
        return { participant };
      }).pipe(Effect.withSpan("tasks.addParticipant")),
  }),

  defineTaskMethod(TasksRemoveParticipant, {
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const taskService = yield* TaskServiceTag;
        yield* taskService.removeParticipant(
          params.taskId,
          ctx.agentId,
          params.agentId,
        );
        return {};
      }).pipe(Effect.withSpan("tasks.removeParticipant")),
  }),

  defineTaskMethod(TasksStoreMessage, {
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const taskService = yield* TaskServiceTag;
        const message = yield* taskService.storeMessage(
          params.taskId,
          ctx.agentId,
          {
            conversationId: params.conversationId,
            senderAgentId: params.senderAgentId,
            parts: params.parts,
            replyToId: params.replyToId,
          },
        );
        return { message };
      }).pipe(Effect.withSpan("tasks.storeMessage")),
  }),

  defineTaskMethod(TasksGetMessages, {
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const taskService = yield* TaskServiceTag;
        return yield* taskService.getMessages(params.taskId, ctx.agentId, {
          conversationId: params.conversationId,
          limit: params.limit,
        });
      }).pipe(Effect.withSpan("tasks.getMessages")),
  }),

  defineTaskMethod(TasksGetMessagesSince, {
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const taskService = yield* TaskServiceTag;
        return yield* taskService.getMessagesSince(params.taskId, ctx.agentId, {
          conversationId: params.conversationId,
          sinceSeq: params.sinceSeq,
          limit: params.limit,
        });
      }).pipe(Effect.withSpan("tasks.getMessagesSince")),
  }),
];
