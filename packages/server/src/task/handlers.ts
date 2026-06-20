/**
 * `agent/task/request` handler — agent-initiated task creation that
 * brokers an app-callback gate via `app/task/create` before the task
 * transitions out of `waiting`.
 *
 * Lives in the task domain. The handler depends on `TaskAuthorizationServiceTag`
 * to fire the `app/task/create` callback over the bound app's connection.
 *
 * Lifecycle (one-way, fail-closed):
 *   1. Validate contact policy + create the task row in `waiting`.
 *   2. Fire `app/task/create` callback to the bound app.
 *      Timeout / RPC error / decode failure synthesizes a reject
 *      verdict with a synthesized reason code.
 *   3. On `accept` → setStatus(active), fan out `agent/task/created` to
 *      caller + invitees, optionally mint the initialConversation,
 *      return `{ task, conversation }`.
 *   4. On `reject` → setStatus(failed), fan out `task/failed` with
 *      reason, fail the RPC with `TaskRejectedError`.
 */
import { Effect } from "effect";
import {
  ConversationArchivedNotificationDefinition,
  ConversationCreatedNotificationDefinition,
  ConversationParticipantsRemovedNotificationDefinition,
} from "@moltzap/protocol/conversation";
import {
  TaskClosedNotificationDefinition,
  TaskCreatedNotificationDefinition,
  TaskFailedNotificationDefinition,
  TaskLeave,
  TaskList,
  TaskRejectedError,
  TaskRequest,
  TaskUpdate,
} from "@moltzap/protocol/task";
import type { AgentId, AppId } from "@moltzap/protocol/identity";
import type { Task } from "@moltzap/protocol/task";
import type { Conversation } from "@moltzap/protocol/conversation";
import type { ServerHandler } from "@moltzap/protocol/socket/catalog";
import type { TaskId } from "@moltzap/protocol/task";
import { InvalidParamsError } from "@moltzap/protocol/rpc";
import type { ParamsOf } from "@moltzap/protocol/rpc";
import type { ConversationId } from "@moltzap/protocol/conversation";
import { ConversationServiceTag } from "#conversation";
import { TaskAuthorizationServiceTag, TaskServiceTag } from "#task";
import { agentArm, appArm } from "#moltzap/runtime";
import { authorizeConversationCreate } from "#conversation/requirements";
import { broadcastNotificationToAgents } from "#network";
import type { AgentContext, AppContext } from "#socket";
import { assertCallerAppOwnsTask } from "#task/requirements";

type TaskRequestParams = {
  readonly appId: AppId;
  readonly invitedAgentIds: ReadonlyArray<AgentId>;
  readonly initialConversation?: {
    readonly name?: string;
    readonly participants?: ReadonlyArray<AgentId>;
  };
};

type TaskRequestCtx = { readonly agentId: AgentId };

interface MintInitialInput {
  readonly task: Task;
  readonly initial: {
    readonly name?: string;
    readonly participants?: ReadonlyArray<AgentId>;
  };
  readonly invitedAgentIds: ReadonlyArray<AgentId>;
  readonly callerAgentId: AgentId;
}

function mintInitialConversation(input: MintInitialInput) {
  return Effect.gen(function* () {
    const conversationService = yield* ConversationServiceTag;
    const participantAgentIds: ReadonlyArray<AgentId> =
      input.initial.participants ?? input.invitedAgentIds;
    yield* authorizeConversationCreate({
      agentIds: [...participantAgentIds],
      creatorAgentId: input.callerAgentId,
    });
    const conversation = yield* conversationService.create({
      name: input.initial.name,
      agentIds: [...participantAgentIds],
      creatorAgentId: input.callerAgentId,
      mintTask: Effect.succeed({ id: input.task.id }),
    });
    const recipientAgentIds: AgentId[] = [
      input.callerAgentId,
      ...participantAgentIds,
    ];
    yield* broadcastNotificationToAgents(
      recipientAgentIds,
      ConversationCreatedNotificationDefinition,
      {
        taskId: input.task.id,
        conversationId: conversation.id,
        name: input.initial.name,
        participants: [...participantAgentIds],
      },
    );
    return { task: input.task, conversation };
  }).pipe(Effect.withSpan("task.request.mintInitialConversation"));
}

// Strip `undefined` optionals so the wire schema's
// `onExcessProperty: "error"` strict decode doesn't reject an
// explicit-undefined.
function initialConversationForWire(params: TaskRequestParams) {
  const initial = params.initialConversation;
  if (initial === undefined) return undefined;
  return {
    ...(initial.name !== undefined ? { name: initial.name } : {}),
    ...(initial.participants !== undefined
      ? { participants: [...initial.participants] }
      : {}),
  };
}

// reject verdict → waiting → failed, fan out task/failed, fail the RPC.
function handleReject(
  taskId: TaskId,
  recipients: AgentId[],
  reason: string | undefined,
) {
  return Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const failedTask = yield* taskService.setStatus(taskId, "failed");
    const reasonField: { reason: string } | Record<string, never> =
      reason !== undefined ? { reason } : {};
    yield* broadcastNotificationToAgents(
      recipients,
      TaskFailedNotificationDefinition,
      { taskId: failedTask.id, ...reasonField },
    );
    // `reason` rides in the wire error's `data` arm (RpcErrorPayload),
    // so the requester can read why without parsing the message.
    return yield* Effect.fail(
      new TaskRejectedError({
        data: { taskId: failedTask.id as string, ...reasonField },
      }),
    );
  }).pipe(Effect.withSpan("task.request.reject"));
}

// accept verdict → waiting → active, fan out agent/task/created, then mint
// the initialConversation hint if present.
function handleAccept(
  waitingTaskId: TaskId,
  params: TaskRequestParams,
  ctx: TaskRequestCtx,
) {
  return Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const activeTask = yield* taskService.setStatus(waitingTaskId, "active");
    yield* broadcastNotificationToAgents(
      [ctx.agentId, ...params.invitedAgentIds],
      TaskCreatedNotificationDefinition,
      { task: activeTask },
    );
    if (params.initialConversation === undefined) {
      return { task: activeTask, conversation: null as Conversation | null };
    }
    return yield* mintInitialConversation({
      task: activeTask,
      initial: params.initialConversation,
      invitedAgentIds: params.invitedAgentIds,
      callerAgentId: ctx.agentId,
    });
  }).pipe(Effect.withSpan("task.request.accept"));
}

function taskRequestBody(params: TaskRequestParams, ctx: TaskRequestCtx) {
  return Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const taskAuthorization = yield* TaskAuthorizationServiceTag;
    // Contact-policy reachability is enforced by the method's requirement
    // middleware before this body runs.
    const waitingTask = yield* taskService.create(ctx.agentId, {
      appId: params.appId,
      invitedAgentIds: params.invitedAgentIds,
    });
    const initial = initialConversationForWire(params);
    const verdict = yield* taskAuthorization.authorizeCreate(params.appId, {
      taskId: waitingTask.id,
      initiatorAgentId: ctx.agentId,
      invitedAgentIds: [...params.invitedAgentIds],
      ...(initial !== undefined ? { initialConversation: initial } : {}),
    });
    return verdict.decision === "reject"
      ? yield* handleReject(
          waitingTask.id,
          [ctx.agentId, ...params.invitedAgentIds],
          verdict.reason,
        )
      : yield* handleAccept(waitingTask.id, params, ctx);
  }).pipe(Effect.withSpan("task.request"));
}

// ── @effect/rpc handler body ─────────────────────────────────────────
//
// The `ContactPolicyAllowsReach` requirement gates the frame before this body
// runs. `agentArm` reads the narrowed principal.
export const taskRequest: ServerHandler<typeof TaskRequest> = (params) =>
  Effect.gen(function* () {
    const ctx = yield* agentArm;
    return yield* taskRequestBody(params, ctx);
  }).pipe(Effect.withSpan("taskRequest"));

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
      ConversationParticipantsRemovedNotificationDefinition,
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

type TaskUpdateParams = ParamsOf<typeof TaskUpdate>;
type TaskUpdateCloseParams = Extract<TaskUpdateParams, { action: "close" }>;
type TaskUpdateAddParticipantParams = Extract<
  TaskUpdateParams,
  { action: "add-participant" }
>;
type TaskUpdateRemoveParticipantParams = Extract<
  TaskUpdateParams,
  { action: "remove-participant" }
>;

function taskCloseBody(params: TaskUpdateCloseParams) {
  return Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const closed = yield* taskService.closeWithLifecycle(params.taskId);
    for (const conversation of closed.archivedConversations) {
      yield* broadcastNotificationToAgents(
        conversation.participantAgentIds,
        ConversationArchivedNotificationDefinition,
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
    return { action: "closed" as const, task: closed.task };
  }).pipe(Effect.withSpan("task.close"));
}

function taskAddParticipantBody(params: TaskUpdateAddParticipantParams) {
  return Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const participant = yield* taskService.addParticipant(
      params.taskId,
      params.agentId,
    );
    return { action: "participant-added" as const, participant };
  }).pipe(Effect.withSpan("task.addParticipant"));
}

function taskRemoveParticipantBody(params: TaskUpdateRemoveParticipantParams) {
  return Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    yield* taskService.removeParticipant(params.taskId, params.agentId);
    return { action: "participant-removed" as const };
  }).pipe(Effect.withSpan("task.removeParticipant"));
}

function taskUpdateBody(params: TaskUpdateParams, ctx: AppContext) {
  return Effect.gen(function* () {
    yield* assertCallerAppOwnsTask(ctx.appId, params.taskId);
    switch (params.action) {
      case "close":
        return yield* taskCloseBody(params);
      case "add-participant":
        return yield* taskAddParticipantBody(params);
      case "remove-participant":
        return yield* taskRemoveParticipantBody(params);
    }
  });
}

export const taskList: ServerHandler<typeof TaskList> = (params) =>
  Effect.gen(function* () {
    return yield* taskListBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("taskList"));

export const taskLeave: ServerHandler<typeof TaskLeave> = (params) =>
  Effect.gen(function* () {
    return yield* taskLeaveBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("taskLeave"));

export const taskUpdate: ServerHandler<typeof TaskUpdate> = (params) =>
  Effect.gen(function* () {
    return yield* taskUpdateBody(params, yield* appArm);
  }).pipe(Effect.withSpan("taskUpdate"));
