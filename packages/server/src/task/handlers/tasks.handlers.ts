import { Effect } from "effect";
import {
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
  agentId as brandAgentId,
} from "@moltzap/protocol";
import { defineTaskMethod } from "../../rpc/define-layered-method.js";
import type { RpcMethodRegistry } from "../../rpc/context.js";
import type { TaskService } from "../../services/task.service.js";

export function createTaskHandlers(deps: {
  taskService: TaskService;
}): RpcMethodRegistry {
  const { taskService } = deps;

  return [
    defineTaskMethod(TasksCreate, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const task = yield* taskService.create(ctx.agentId, {
            appId: params.appId,
            invitedAgentIds: params.invitedAgentIds,
          });
          return { task };
        }),
    }),

    defineTaskMethod(TasksGet, {
      handler: (params, ctx) => taskService.get(params.taskId, ctx.agentId),
    }),

    defineTaskMethod(TasksList, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const tasks = yield* taskService.list(ctx.agentId, {
            appId: params.appId,
            status: params.status,
            limit: params.limit,
          });
          return { tasks: [...tasks] };
        }),
    }),

    defineTaskMethod(TasksClose, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const task = yield* taskService.close(params.taskId, ctx.agentId);
          return { task };
        }),
    }),

    defineTaskMethod(TasksCreateConversation, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const conversation = yield* taskService.createConversation(
            params.taskId,
            ctx.agentId,
            {
              type: params.type,
              name: params.name,
              participantAgentIds: params.participants.map((p) =>
                brandAgentId(p.id),
              ),
            },
          );
          return { conversation };
        }),
    }),

    defineTaskMethod(TasksCloseConversation, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          yield* taskService.closeConversation(
            params.taskId,
            ctx.agentId,
            params.conversationId,
          );
          return {};
        }),
    }),

    defineTaskMethod(TasksAddParticipant, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          const participant = yield* taskService.addParticipant(
            params.taskId,
            ctx.agentId,
            params.agentId,
          );
          return { participant };
        }),
    }),

    defineTaskMethod(TasksRemoveParticipant, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
          yield* taskService.removeParticipant(
            params.taskId,
            ctx.agentId,
            params.agentId,
          );
          return {};
        }),
    }),

    defineTaskMethod(TasksStoreMessage, {
      handler: (params, ctx) =>
        Effect.gen(function* () {
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
        }),
    }),

    defineTaskMethod(TasksGetMessages, {
      handler: (params, ctx) =>
        taskService.getMessages(params.taskId, ctx.agentId, {
          conversationId: params.conversationId,
          limit: params.limit,
        }),
    }),

    defineTaskMethod(TasksGetMessagesSince, {
      handler: (params, ctx) =>
        taskService.getMessagesSince(params.taskId, ctx.agentId, {
          conversationId: params.conversationId,
          sinceSeq: params.sinceSeq,
          limit: params.limit,
        }),
    }),
  ];
}
