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
  conversationArchivedNotificationDefinition,
  conversationCreatedNotificationDefinition,
  conversationParticipantsRemovedNotificationDefinition,
  type Conversation,
  type ConversationId,
} from "@moltzap/protocol/conversation";
import {
  taskClosedNotificationDefinition,
  taskCreatedNotificationDefinition,
  taskFailedNotificationDefinition,
  type taskLeave as taskLeaveDefinition,
  type taskList as taskListDefinition,
  TaskRejectedError,
  type taskRequest as taskRequestDefinition,
  type taskUpdate as taskUpdateDefinition,
  type Task,
  type TaskId,
} from "@moltzap/protocol/task";

import type { AgentId, AppId } from "@moltzap/protocol/identity";
import type { ServerHandler } from "@moltzap/protocol/socket/catalog";
import { InvalidParamsError, type ParamsOf } from "@moltzap/protocol/rpc";
import { ConversationServiceTag } from "#conversation";
import { TaskAuthorizationServiceTag, TaskServiceTag } from "./layer.js";
import { agentArm, appArm } from "#moltzap/runtime";
import { authorizeConversationCreateCapacityOnly } from "#conversation/requirements";
import { broadcastNotificationToAgents } from "#network";
import type { AgentContext, AppContext } from "#socket";
import { assertCallerAppOwnsTask } from "#task/requirements";

const EMPTY_AGENT_IDS: readonly AgentId[] = [];

interface TaskRequestParams {
  readonly appId: AppId;
  readonly invitedAgentIds: readonly AgentId[];
  readonly initialConversation?: {
    readonly name?: string;
    readonly participants?: readonly AgentId[];
  };
}

interface TaskRequestCtx {
  readonly agentId: AgentId;
}

interface MintInitialInput {
  readonly task: Task;
  readonly initial: {
    readonly name?: string;
    readonly participants?: readonly AgentId[];
  };
  readonly invitedAgentIds: readonly AgentId[];
  readonly callerAgentId: AgentId;
}

const mintInitialConversation = Effect.fn(
  "task.request.mintInitialConversation",
)(function* (input: MintInitialInput) {
  const conversationService = yield* ConversationServiceTag;
  const participantAgentIds: readonly AgentId[] =
    input.initial.participants ?? input.invitedAgentIds;
  yield* authorizeConversationCreateCapacityOnly(participantAgentIds);
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
    conversationCreatedNotificationDefinition,
    {
      taskId: input.task.id,
      conversationId: conversation.id,
      name: input.initial.name,
      participants: [...participantAgentIds],
    },
  );
  return { task: input.task, conversation };
});

// Strip `undefined` optionals so the wire schema's
// `onExcessProperty: "error"` strict decode doesn't reject an
// explicit-undefined.
function initialConversationForWire(params: TaskRequestParams) {
  const initial = params.initialConversation;
  if (initial === undefined) {
    return undefined;
  }
  return {
    ...(initial.name !== undefined ? { name: initial.name } : {}),
    ...(initial.participants !== undefined
      ? { participants: [...initial.participants] }
      : {}),
  };
}

// reject verdict → waiting → failed, fan out task/failed, fail the RPC.
const handleReject = Effect.fn("task.request.reject")(function* (
  taskId: TaskId,
  recipients: AgentId[],
  reason?: string,
) {
  const taskService = yield* TaskServiceTag;
  const failedTask = yield* taskService.setStatus(taskId, "failed");
  const reasonField: { reason: string } | Record<string, never> =
    reason !== undefined ? { reason } : {};
  yield* broadcastNotificationToAgents(
    recipients,
    taskFailedNotificationDefinition,
    { taskId: failedTask.id, ...reasonField },
  );
  // `reason` rides in the wire error's `data` arm (RpcErrorPayload),
  // so the requester can read why without parsing the message.
  return yield* new TaskRejectedError({
    data: {
      taskId:
        /* Safe because the surrounding invariant establishes this asserted shape. */ failedTask.id as string,
      ...reasonField,
    },
  });
});

// accept verdict → waiting → active, fan out agent/task/created, then mint
// the initialConversation hint if present.
const handleAccept = Effect.fn("task.request.accept")(function* (
  waitingTaskId: TaskId,
  params: TaskRequestParams,
  ctx: TaskRequestCtx,
) {
  const taskService = yield* TaskServiceTag;
  const activeTask = yield* taskService.setStatus(waitingTaskId, "active");
  yield* broadcastNotificationToAgents(
    [ctx.agentId, ...params.invitedAgentIds],
    taskCreatedNotificationDefinition,
    { task: activeTask },
  );
  if (params.initialConversation === undefined) {
    return {
      task: activeTask,
      conversation:
        /* Safe because the surrounding invariant establishes this asserted shape. */ null as Conversation | null,
    };
  }
  return yield* mintInitialConversation({
    task: activeTask,
    initial: params.initialConversation,
    invitedAgentIds: params.invitedAgentIds,
    callerAgentId: ctx.agentId,
  });
});

const taskRequestBody = Effect.fn("task.request")(function* (
  params: TaskRequestParams,
  ctx: TaskRequestCtx,
) {
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
});

// ── @effect/rpc handler body ─────────────────────────────────────────
//
// The `ContactPolicyAllowsReach` requirement gates the frame before this body
// runs. `agentArm` reads the narrowed principal.
/**
 * Provides the task request runtime value.
 * @param params Request payload to process.
 * @returns The task leave body result.
 */
export const taskRequest: ServerHandler<typeof taskRequestDefinition> =
  Effect.fn("taskRequest")(function* (params) {
    const ctx = yield* agentArm;
    return yield* taskRequestBody(params, ctx);
  });

const taskLeaveBody = Effect.fn("task.leave")(function* (
  params: ParamsOf<typeof taskLeaveDefinition>,
  ctx: { readonly agentId: AgentId },
) {
  const taskService = yield* TaskServiceTag;
  const { leftConversationIds, closedTask } = yield* taskService.leaveTask(
    params.taskId,
    ctx.agentId,
  );
  for (const conversationId of leftConversationIds) {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define -- fanout is invoked after module initialization.
    yield* fanoutLeaveParticipantRemoval({
      taskId: params.taskId,
      conversationId,
      leaver: ctx.agentId,
    });
  }
  if (closedTask !== null) {
    yield* broadcastNotificationToAgents(
      [ctx.agentId],
      taskClosedNotificationDefinition,
      { task: closedTask },
    );
  }
  return {};
});

interface LeaveParticipantFanoutInput {
  readonly taskId: ParamsOf<typeof taskLeaveDefinition>["taskId"];
  readonly conversationId: ConversationId;
  readonly leaver: AgentId;
}

const fanoutLeaveParticipantRemoval = Effect.fn("task.leave.fanout")(function* (
  input: LeaveParticipantFanoutInput,
) {
  const conversationService = yield* ConversationServiceTag;
  const remaining = yield* conversationService
    .getParticipantAgentIds(input.conversationId)
    .pipe(Effect.orElseSucceed(() => EMPTY_AGENT_IDS));
  const recipientAgentIds: AgentId[] = [input.leaver, ...remaining];
  yield* broadcastNotificationToAgents(
    recipientAgentIds,
    conversationParticipantsRemovedNotificationDefinition,
    {
      taskId: input.taskId,
      conversationId: input.conversationId,
      removedAgentId: input.leaver,
      reason: "task_leave" as const,
    },
  );
});

const taskListBody = Effect.fn("task.list")(function* (
  params: ParamsOf<typeof taskListDefinition>,
  ctx: AgentContext,
) {
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
});

type TaskUpdateParams = ParamsOf<typeof taskUpdateDefinition>;
type TaskUpdateCloseParams = Extract<TaskUpdateParams, { action: "close" }>;
type TaskUpdateAddParticipantParams = Extract<
  TaskUpdateParams,
  { action: "add-participant" }
>;
type TaskUpdateRemoveParticipantParams = Extract<
  TaskUpdateParams,
  { action: "remove-participant" }
>;

const taskCloseBody = Effect.fn("task.close")(function* (
  params: TaskUpdateCloseParams,
) {
  const taskService = yield* TaskServiceTag;
  const closed = yield* taskService.closeWithLifecycle(params.taskId);
  for (const conversation of closed.archivedConversations) {
    yield* broadcastNotificationToAgents(
      conversation.participantAgentIds,
      conversationArchivedNotificationDefinition,
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
    taskClosedNotificationDefinition,
    { task: closed.task },
  );
  return { action: "closed" as const, task: closed.task };
});

const taskAddParticipantBody = Effect.fn("task.addParticipant")(function* (
  params: TaskUpdateAddParticipantParams,
) {
  const taskService = yield* TaskServiceTag;
  const participant = yield* taskService.addParticipant(
    params.taskId,
    params.agentId,
  );
  return { action: "participant-added" as const, participant };
});

const taskRemoveParticipantBody = Effect.fn("task.removeParticipant")(
  function* (params: TaskUpdateRemoveParticipantParams) {
    const taskService = yield* TaskServiceTag;
    yield* taskService.removeParticipant(params.taskId, params.agentId);
    return { action: "participant-removed" as const };
  },
);

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
      default: {
        const exhaustive: never = params;
        return exhaustive;
      }
    }
  });
}

/**
 * Provides the task list runtime value.
 * @param params Request payload to process.
 * @returns The task list result.
 */
export const taskList: ServerHandler<typeof taskListDefinition> = Effect.fn(
  "taskList",
)(function* (params) {
  return yield* taskListBody(params, yield* agentArm);
});

/**
 * Provides the task leave runtime value.
 * @param params Request payload to process.
 * @returns The task leave result.
 */
export const taskLeave: ServerHandler<typeof taskLeaveDefinition> = Effect.fn(
  "taskLeave",
)(function* (params) {
  return yield* taskLeaveBody(params, yield* agentArm);
});

/**
 * Provides the task update runtime value.
 * @param params Request payload to process.
 * @returns The task update result.
 */
export const taskUpdate: ServerHandler<typeof taskUpdateDefinition> = Effect.fn(
  "taskUpdate",
)(function* (params) {
  return yield* taskUpdateBody(params, yield* appArm);
});

// safer-arch-ignore no-fat-orchestrator: The task RPC adapter coordinates the task lifecycle and notification fan-out while domain state remains in services.
