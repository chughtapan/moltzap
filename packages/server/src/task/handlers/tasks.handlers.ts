import { Effect } from "effect";
import {
  TaskAddParticipant,
  TaskClose,
  TaskClosedNotificationDefinition,
  TaskLeave,
  TaskList,
  TaskRemoveParticipant,
} from "@moltzap/protocol/task";
import {
  TaskConversationArchivedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
} from "@moltzap/protocol/conversation";
import { InvalidParamsError } from "@moltzap/protocol/rpc";
import type { ParamsOf } from "@moltzap/protocol/rpc";
import type { ServerHandler } from "@moltzap/protocol/socket";
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { AgentContext, AppContext } from "#socket";
import type { AgentId } from "#core";
import { ConversationServiceTag, TaskServiceTag } from "#core";
import { broadcastNotificationToAgents } from "#network";
import { assertCallerAppOwnsTask } from "#task/requirements";
import { agentArm, appArm } from "#core";

function taskLeaveBody(
  params: ParamsOf<typeof TaskLeave>,
  ctx: { readonly agentId: AgentId },
) {
  return Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const { leftConversationIds, closedTask } = yield* taskService.leaveTask(
      params.taskId,
      ctx.agentId,
    );
    for (const conversationId of leftConversationIds) {
      yield* fanoutLeaveParticipantRemoval({
        taskId: params.taskId,
        conversationId,
        leaver: ctx.agentId,
      });
    }
    if (closedTask !== null) {
      yield* broadcastNotificationToAgents(
        [ctx.agentId],
        TaskClosedNotificationDefinition,
        { task: closedTask },
      );
    }
    return {};
  }).pipe(Effect.withSpan("task.leave"));
}

interface LeaveParticipantFanoutInput {
  readonly taskId: ParamsOf<typeof TaskLeave>["taskId"];
  readonly conversationId: ConversationId;
  readonly leaver: AgentId;
}

function fanoutLeaveParticipantRemoval(input: LeaveParticipantFanoutInput) {
  return Effect.gen(function* () {
    const conversationService = yield* ConversationServiceTag;
    const remaining = yield* conversationService
      .getParticipantAgentIds(input.conversationId)
      .pipe(Effect.orElseSucceed(() => [] as readonly AgentId[]));
    const recipientAgentIds: AgentId[] = [input.leaver, ...remaining];
    yield* broadcastNotificationToAgents(
      recipientAgentIds,
      TaskConversationParticipantsRemovedNotificationDefinition,
      {
        taskId: input.taskId,
        conversationId: input.conversationId,
        removedAgentId: input.leaver,
        reason: "task_leave" as const,
      },
    );
  }).pipe(Effect.withSpan("task.leave.fanout"));
}

function taskListBody(params: ParamsOf<typeof TaskList>, ctx: AgentContext) {
  return Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const { tasks, nextCursor } = yield* taskService
      .list(ctx.agentId, { limit: params.limit, cursor: params.cursor })
      .pipe(
        Effect.catchTag("InvalidCursor", (err) =>
          Effect.fail(new InvalidParamsError({ message: err.message })),
        ),
      );
    return {
      tasks: [...tasks],
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
  }).pipe(Effect.withSpan("task.list"));
}

function taskCloseBody(params: ParamsOf<typeof TaskClose>, ctx: AppContext) {
  return Effect.gen(function* () {
    yield* assertCallerAppOwnsTask(ctx.appId, params.taskId);
    const taskService = yield* TaskServiceTag;
    const closed = yield* taskService.closeWithLifecycle(params.taskId);
    for (const conversation of closed.archivedConversations) {
      yield* broadcastNotificationToAgents(
        conversation.participantAgentIds,
        TaskConversationArchivedNotificationDefinition,
        {
          taskId: params.taskId,
          conversationId: conversation.conversationId,
          archivedAt: conversation.archivedAt,
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
  }).pipe(Effect.withSpan("task.close"));
}

function taskAddParticipantBody(
  params: ParamsOf<typeof TaskAddParticipant>,
  ctx: AppContext,
) {
  return Effect.gen(function* () {
    yield* assertCallerAppOwnsTask(ctx.appId, params.taskId);
    const taskService = yield* TaskServiceTag;
    const participant = yield* taskService.addParticipant(
      params.taskId,
      params.agentId,
    );
    return { participant };
  }).pipe(Effect.withSpan("task.addParticipant"));
}

function taskRemoveParticipantBody(
  params: ParamsOf<typeof TaskRemoveParticipant>,
  ctx: AppContext,
) {
  return Effect.gen(function* () {
    yield* assertCallerAppOwnsTask(ctx.appId, params.taskId);
    const taskService = yield* TaskServiceTag;
    yield* taskService.removeParticipant(params.taskId, params.agentId);
    return {};
  }).pipe(Effect.withSpan("task.removeParticipant"));
}

export const taskList: ServerHandler<typeof TaskList> = (params) =>
  Effect.gen(function* () {
    return yield* taskListBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("taskList"));

export const taskLeave: ServerHandler<typeof TaskLeave> = (params) =>
  Effect.gen(function* () {
    return yield* taskLeaveBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("taskLeave"));

export const taskClose: ServerHandler<typeof TaskClose> = (params) =>
  Effect.gen(function* () {
    return yield* taskCloseBody(params, yield* appArm);
  }).pipe(Effect.withSpan("taskClose"));

export const taskAddParticipant: ServerHandler<typeof TaskAddParticipant> = (
  params,
) =>
  Effect.gen(function* () {
    return yield* taskAddParticipantBody(params, yield* appArm);
  }).pipe(Effect.withSpan("taskAddParticipant"));

export const taskRemoveParticipant: ServerHandler<
  typeof TaskRemoveParticipant
> = (params) =>
  Effect.gen(function* () {
    return yield* taskRemoveParticipantBody(params, yield* appArm);
  }).pipe(Effect.withSpan("taskRemoveParticipant"));
