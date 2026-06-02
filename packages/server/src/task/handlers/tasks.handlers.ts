import { Effect } from "effect";
import {
  TaskClosedNotificationDefinition,
  TaskConversationAddParticipant,
  TaskConversationArchive,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationCreate,
  TaskConversationCreatedNotificationDefinition,
  TaskConversationList,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
  TaskConversationRemoveParticipant,
  TaskConversationUnarchive,
  TaskConversationUnarchivedNotificationDefinition,
  TaskLeave,
  TaskAddParticipant,
  TaskClose,
  TaskList,
  TaskRemoveParticipant,
  InvalidParamsError,
  type Conversation,
  type ParamsOf,
  type TaskConversationListItem,
} from "@moltzap/protocol";
import {
  ConversationCreateAuthorization,
  assertAppOwnsTask,
  type AppId,
  type ConversationId,
  type TaskId,
} from "@moltzap/protocol/task";
import type { AgentContext, AppContext } from "../../transport/context.js";
import type { AgentId } from "../../app/types.js";
import { ConversationServiceTag, TaskServiceTag } from "../../app/layers.js";
import { obtainConversationCreateCapacityOnly } from "../services/conversation-create-authorization.js";
import { broadcastNotificationToAgents } from "./notification-broadcast.js";
import { agentArm, appArm } from "../../app/native-handlers-runtime.js";

/**
 * App-arm authority gate for the task-admin RPCs: the app must own the
 * task. Loads the open task (status `waiting | active`) and asserts
 * ownership, returning the loaded `Task` so the handler body can reuse
 * it (e.g. the `task.initiatorAgentId` creator-of-record on
 * `task/conversation/create`).
 *
 * The caller is guaranteed to be an `AppConnection`: every binding here
 * is `callablePrincipal: "app"`, so the dispatcher's principal gate
 * rejects a non-app arm with `ForbiddenError` before the body runs. The
 * `appId` flows from the narrowed {@link AppContext} `ctx.appId`.
 */
function assertCallerAppOwnsTask(appId: AppId, taskId: TaskId) {
  return Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const task = yield* taskService.loadOpenTask(taskId);
    yield* assertAppOwnsTask(appId, task);
    return task;
  }).pipe(Effect.withSpan("task.assertCallerAppOwnsTask"));
}

// `task/request`'s native handler lives in
// `packages/server/src/app/handlers/task-request.handler.ts` — it fires the
// `task/create` TM callback through `AppHost` (an app-layer service). The
// descriptor itself stays in `@moltzap/protocol/task`.

function taskConversationCreateBody(
  appId: AppId,
  params: {
    readonly taskId: TaskId;
    readonly name?: string;
    readonly participants: ReadonlyArray<AgentId>;
  },
) {
  return Effect.gen(function* () {
    // App-ownership gate first so a non-owner sees ForbiddenError, not
    // ParticipantNotAdmittedError (which would leak task state). The
    // loaded task carries `initiatorAgentId` = creator-of-record.
    const task = yield* assertCallerAppOwnsTask(appId, params.taskId);
    const taskService = yield* TaskServiceTag;
    const conversationService = yield* ConversationServiceTag;
    yield* taskService.requireAgentsAreInTaskParticipants(
      params.taskId,
      params.participants,
    );
    // createdBy = task.initiatorAgentId (the agent that sent the initial
    // task/request); membership = exactly params.participants (the
    // initiator is NOT injected). Authorization is capacity-only — a TM
    // minting on the task's behalf has no agent contact-edges; the
    // targets are gated by `requireAgentsAreInTaskParticipants` above.
    const conversation = yield* conversationService
      .create({
        name: params.name,
        agentIds: [...params.participants],
        creatorAgentId: task.initiatorAgentId,
        seedCreatorAsParticipant: false,
        mintTask: Effect.succeed({ id: params.taskId }),
      })
      .pipe(
        Effect.provideServiceEffect(
          ConversationCreateAuthorization,
          obtainConversationCreateCapacityOnly([...params.participants]),
        ),
      );
    yield* fanoutTaskConversationCreate({
      taskId: params.taskId,
      conversation,
      participants: params.participants,
      name: params.name,
    });
    return { conversation };
  }).pipe(Effect.withSpan("task.conversation.create"));
}

interface TaskConversationCreateInput {
  readonly taskId: TaskId;
  readonly conversation: Conversation;
  readonly participants: ReadonlyArray<AgentId>;
  readonly name?: string;
}

function fanoutTaskConversationCreate(input: TaskConversationCreateInput) {
  // Recipients = exactly the initial participants. The app caller is NOT
  // an agent-broadcast target — its confirmation is the RPC
  // `{conversation}` response, and the agent-broadcast channel cannot
  // reach an `AppConnection`.
  const recipientAgentIds: AgentId[] = [...input.participants];
  return broadcastNotificationToAgents(
    recipientAgentIds,
    TaskConversationCreatedNotificationDefinition,
    {
      taskId: input.taskId,
      conversationId: input.conversation.id,
      name: input.name,
      participants: [...input.participants],
    },
  ).pipe(Effect.withSpan("task.conversation.create.fanout"));
}

function taskLeaveBody(
  params: { readonly taskId: TaskId },
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
      // Last-participant task closure fans out `task/closed { task }`.
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
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly leaver: AgentId;
}

function fanoutLeaveParticipantRemoval(input: LeaveParticipantFanoutInput) {
  return Effect.gen(function* () {
    // Recipients: the leaver PLUS the remaining participants on the
    // conversation. The leaver is included so they receive their own
    // removal notification (post-DELETE the leaver is no longer in
    // `conversation_participants`, so we snapshot membership
    // explicitly).
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

interface ArchiveFanoutInput {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly archivedAt: string;
}

function fanoutArchive(input: ArchiveFanoutInput) {
  return Effect.gen(function* () {
    const conversationService = yield* ConversationServiceTag;
    const recipientAgentIds = yield* conversationService
      .getParticipantAgentIds(input.conversationId)
      .pipe(Effect.orElseSucceed(() => [] as readonly AgentId[]));
    yield* broadcastNotificationToAgents(
      recipientAgentIds,
      TaskConversationArchivedNotificationDefinition,
      {
        taskId: input.taskId,
        conversationId: input.conversationId,
        archivedAt: input.archivedAt,
      },
      { forConversation: input.conversationId },
    );
  }).pipe(Effect.withSpan("task.conversation.archive.fanout"));
}

interface UnarchiveFanoutInput {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}

function fanoutUnarchive(input: UnarchiveFanoutInput) {
  return Effect.gen(function* () {
    const conversationService = yield* ConversationServiceTag;
    const recipientAgentIds = yield* conversationService
      .getParticipantAgentIds(input.conversationId)
      .pipe(Effect.orElseSucceed(() => [] as readonly AgentId[]));
    yield* broadcastNotificationToAgents(
      recipientAgentIds,
      TaskConversationUnarchivedNotificationDefinition,
      {
        taskId: input.taskId,
        conversationId: input.conversationId,
      },
      { forConversation: input.conversationId },
    );
  }).pipe(Effect.withSpan("task.conversation.unarchive.fanout"));
}

function taskListBody(params: ParamsOf<typeof TaskList>, ctx: AgentContext) {
  return Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const { tasks, nextCursor } = yield* taskService
      .list(ctx.agentId, { limit: params.limit, cursor: params.cursor })
      .pipe(
        // A bad cursor is an invalid client param, not an internal defect.
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

function taskConversationListBody(
  params: ParamsOf<typeof TaskConversationList>,
  ctx: AgentContext,
) {
  return Effect.gen(function* () {
    const conversationService = yield* ConversationServiceTag;
    // `archived: "include"` — archived rows are surfaced and the client filters
    // `conversation.archivedAt` locally.
    const { conversations, cursor: nextCursor } =
      yield* conversationService.list(
        ctx.agentId,
        params.limit,
        params.cursor,
        "include",
      );
    // Each `TaskConversationListItem` needs the full conversation row and
    // participant set, which the list projection omits; fetch both per summary.
    const items: TaskConversationListItem[] = [];
    for (const summary of conversations) {
      const conversation = yield* conversationService.loadById(summary.id);
      const participants = yield* conversationService
        .getParticipantAgentIds(summary.id)
        .pipe(Effect.orElseSucceed(() => [] as readonly AgentId[]));
      const linkedTaskId = yield* conversationService.taskIdForConversation(
        summary.id,
      );
      items.push({
        taskId: linkedTaskId,
        conversation,
        participants: [...participants],
      });
    }
    return { items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
  }).pipe(Effect.withSpan("task.conversation.list"));
}

// `ConversationInTask` is woven (live path) / proof-provided (native path);
// consumed inside `archiveTaskConversation`.
function taskConversationArchiveBody(
  params: ParamsOf<typeof TaskConversationArchive>,
  ctx: AppContext,
) {
  return Effect.gen(function* () {
    yield* assertCallerAppOwnsTask(ctx.appId, params.taskId);
    const taskService = yield* TaskServiceTag;
    const { archivedAt } = yield* taskService.archiveTaskConversation(
      params.taskId,
      params.conversationId,
    );
    yield* fanoutArchive({
      taskId: params.taskId,
      conversationId: params.conversationId,
      archivedAt,
    });
    return {};
  }).pipe(Effect.withSpan("task.conversation.archive"));
}

function taskConversationUnarchiveBody(
  params: ParamsOf<typeof TaskConversationUnarchive>,
  ctx: AppContext,
) {
  return Effect.gen(function* () {
    yield* assertCallerAppOwnsTask(ctx.appId, params.taskId);
    const taskService = yield* TaskServiceTag;
    yield* taskService.unarchiveTaskConversation(
      params.taskId,
      params.conversationId,
    );
    yield* fanoutUnarchive({
      taskId: params.taskId,
      conversationId: params.conversationId,
    });
    return {};
  }).pipe(Effect.withSpan("task.conversation.unarchive"));
}

function taskConversationAddParticipantBody(
  params: ParamsOf<typeof TaskConversationAddParticipant>,
  ctx: AppContext,
) {
  return Effect.gen(function* () {
    // App-ownership gate first — same rationale as `taskConversationCreateBody`
    // (so a non-owner sees ForbiddenError before
    // `requireAgentsAreInTaskParticipants` can leak task-state).
    yield* assertCallerAppOwnsTask(ctx.appId, params.taskId);
    const taskService = yield* TaskServiceTag;
    // Participant-admitted invariant — runs AFTER app-ownership auth.
    yield* taskService.requireAgentsAreInTaskParticipants(params.taskId, [
      params.agentId,
    ]);
    const { postMutationParticipants } =
      yield* taskService.addTaskConversationParticipant(
        params.taskId,
        params.conversationId,
        params.agentId,
      );
    // Post-mutation membership drives fan-out so the newcomer receives their
    // own added notification.
    yield* broadcastNotificationToAgents(
      postMutationParticipants,
      TaskConversationParticipantsAddedNotificationDefinition,
      {
        taskId: params.taskId,
        conversationId: params.conversationId,
        addedAgentId: params.agentId,
      },
    );
    return {};
  }).pipe(Effect.withSpan("task.conversation.participants.add"));
}

function taskConversationRemoveParticipantBody(
  params: ParamsOf<typeof TaskConversationRemoveParticipant>,
  ctx: AppContext,
) {
  return Effect.gen(function* () {
    yield* assertCallerAppOwnsTask(ctx.appId, params.taskId);
    const taskService = yield* TaskServiceTag;
    const { preMutationParticipants, wasParticipant } =
      yield* taskService.removeTaskConversationParticipant(
        params.taskId,
        params.conversationId,
        params.agentId,
      );
    if (!wasParticipant) {
      // Idempotent no-op: no notifications fire when the agent was not in
      // `conversation_participants`.
      return {};
    }
    // Pre-mutation membership drives fan-out so the removed agent still
    // receives the notification.
    yield* broadcastNotificationToAgents(
      preMutationParticipants,
      TaskConversationParticipantsRemovedNotificationDefinition,
      {
        taskId: params.taskId,
        conversationId: params.conversationId,
        removedAgentId: params.agentId,
        reason: "app_remove" as const,
      },
    );
    return {};
  }).pipe(Effect.withSpan("task.conversation.participants.remove"));
}

// `task/*` + `task/conversation/*` handlers. Per-flow walkthrough lives in the
// family-overview header block in `packages/protocol/src/task/tasks.ts` (above
// `InitialConversationSchema`).
//
// ── Native @effect/rpc handler bodies ───────────────────────────────────────
//
// The cap-less app/agent methods read only their `*Auth` proof for the gate.
// The four `task/conversation/*` admin methods provide their `ConversationInTask`
// proof off the `*Auth` proof as a service before running the shared body.

export const nativeTaskList = (params: ParamsOf<typeof TaskList>) =>
  Effect.gen(function* () {
    return yield* taskListBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("nativeTaskList"));

export const nativeTaskLeave = (params: ParamsOf<typeof TaskLeave>) =>
  Effect.gen(function* () {
    return yield* taskLeaveBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("nativeTaskLeave"));

export const nativeTaskConversationList = (
  params: ParamsOf<typeof TaskConversationList>,
) =>
  Effect.gen(function* () {
    return yield* taskConversationListBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("nativeTaskConversationList"));

export const nativeTaskClose = (params: ParamsOf<typeof TaskClose>) =>
  Effect.gen(function* () {
    return yield* taskCloseBody(params, yield* appArm);
  }).pipe(Effect.withSpan("nativeTaskClose"));

export const nativeTaskAddParticipant = (
  params: ParamsOf<typeof TaskAddParticipant>,
) =>
  Effect.gen(function* () {
    return yield* taskAddParticipantBody(params, yield* appArm);
  }).pipe(Effect.withSpan("nativeTaskAddParticipant"));

export const nativeTaskRemoveParticipant = (
  params: ParamsOf<typeof TaskRemoveParticipant>,
) =>
  Effect.gen(function* () {
    return yield* taskRemoveParticipantBody(params, yield* appArm);
  }).pipe(Effect.withSpan("nativeTaskRemoveParticipant"));

export const nativeTaskConversationCreate = (
  params: ParamsOf<typeof TaskConversationCreate>,
) =>
  Effect.gen(function* () {
    return yield* taskConversationCreateBody((yield* appArm).appId, params);
  }).pipe(Effect.withSpan("nativeTaskConversationCreate"));

export const nativeTaskConversationArchive = (
  params: ParamsOf<typeof TaskConversationArchive>,
) =>
  Effect.gen(function* () {
    return yield* taskConversationArchiveBody(params, yield* appArm);
  }).pipe(Effect.withSpan("nativeTaskConversationArchive"));

export const nativeTaskConversationUnarchive = (
  params: ParamsOf<typeof TaskConversationUnarchive>,
) =>
  Effect.gen(function* () {
    return yield* taskConversationUnarchiveBody(params, yield* appArm);
  }).pipe(Effect.withSpan("nativeTaskConversationUnarchive"));

export const nativeTaskConversationAddParticipant = (
  params: ParamsOf<typeof TaskConversationAddParticipant>,
) =>
  Effect.gen(function* () {
    return yield* taskConversationAddParticipantBody(params, yield* appArm);
  }).pipe(Effect.withSpan("nativeTaskConversationAddParticipant"));

export const nativeTaskConversationRemoveParticipant = (
  params: ParamsOf<typeof TaskConversationRemoveParticipant>,
) =>
  Effect.gen(function* () {
    return yield* taskConversationRemoveParticipantBody(params, yield* appArm);
  }).pipe(Effect.withSpan("nativeTaskConversationRemoveParticipant"));
