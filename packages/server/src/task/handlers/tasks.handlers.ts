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
  provideMiddleware,
  type Conversation,
  type TaskConversationListItem,
} from "@moltzap/protocol";
import {
  ConversationCreateAuthorization,
  assertAppOwnsTask,
  type AppId,
  type ConversationId,
  type TaskId,
} from "@moltzap/protocol/task";
import {
  defineAppMethod,
  defineAppMiddlewareMethod,
  defineTaskMethod,
} from "../../transport/define-layered-method.js";
import type { ServerRpcSlots } from "../../transport/context.js";
import type { AgentId } from "../../app/types.js";
import { ConversationServiceTag, TaskServiceTag } from "../../app/layers.js";
import {
  conversationInTaskForArchive,
  conversationInTaskForUnarchive,
  conversationInTaskForAddParticipant,
  conversationInTaskForRemoveParticipant,
} from "../../app/capability-middlewares.js";
import { obtainConversationCreateCapacityOnly } from "../services/conversation-create-authorization.js";
import { broadcastNotificationToAgents } from "./notification-broadcast.js";

/**
 * App-arm authority gate for the 8 task-admin RPCs (D #705 R7). The
 * dissolved `TmAuthority` capability moved up to the handler: the app must
 * own the task. Loads the open task (status `waiting | active`) and asserts
 * ownership, returning the loaded `Task` so the handler body can reuse it
 * (e.g. the `task.initiatorAgentId` creator-of-record on
 * `task/conversation/create`).
 *
 * D #705 #720 §B3 — the caller is GUARANTEED to be an `AppConnection`: every
 * binding here is `callablePrincipal: "app"`, so the dispatcher's principal
 * gate rejects a non-app arm with `ForbiddenError` before the body runs. The
 * `appId` flows from the narrowed {@link AppContext} `ctx.appId`; the former
 * in-body `connection._tag !== "AppConnection"` re-check (a runtime check made
 * structurally unreachable) is deleted.
 */
function assertCallerAppOwnsTask(appId: AppId, taskId: TaskId) {
  return Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const task = yield* taskService.loadOpenTask(taskId);
    yield* assertAppOwnsTask(appId, task);
    return task;
  }).pipe(Effect.withSpan("task.assertCallerAppOwnsTask"));
}

// `task/request` lives in `packages/server/src/app/handlers/task-request.handler.ts`
// — its handler binds via `defineAppMiddlewareMethod` because it dispatches
// the `task/create` TM callback through `AppHost`, which is an app-layer
// service. The descriptor itself stays in `@moltzap/protocol/task`;
// only the binding moves up a layer.

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
    // loaded task carries `initiatorAgentId` = creator-of-record (R3).
    const task = yield* assertCallerAppOwnsTask(appId, params.taskId);
    const taskService = yield* TaskServiceTag;
    const conversationService = yield* ConversationServiceTag;
    yield* taskService.requireAgentsAreInTaskParticipants(
      params.taskId,
      params.participants,
    );
    // D #705 R3: createdBy = task.initiatorAgentId (the agent that sent
    // the initial task/request); membership = exactly params.participants
    // (the initiator is NOT injected). Authorization is capacity-only —
    // a TM minting on the task's behalf has no agent contact-edges; the
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
  // Recipients = exactly the initial participants (D #705 R3). The app
  // caller is NOT an agent-broadcast target — its confirmation is the
  // RPC `{conversation}` response, and the agent-broadcast channel
  // cannot reach an `AppConnection`. (Dropped the legacy `callerAgentId`
  // fanout entry along with the agent-shaped ctx.)
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
      yield* fanoutLeaveParticipantDualEmit({
        taskId: params.taskId,
        conversationId,
        leaver: ctx.agentId,
      });
    }
    if (closedTask !== null) {
      // Last-participant task closure. `task/closed { task }` reuses
      // the EXISTING `TaskClosedNotificationDefinition` payload shape
      // per architect plan §R9.
      yield* broadcastNotificationToAgents(
        [ctx.agentId],
        TaskClosedNotificationDefinition,
        { task: closedTask },
      );
    }
    return {};
  }).pipe(Effect.withSpan("task.leave"));
}

interface LeaveParticipantDualEmitInput {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly leaver: AgentId;
}

function fanoutLeaveParticipantDualEmit(input: LeaveParticipantDualEmitInput) {
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

interface ArchiveDualEmitInput {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly archivedAt: string;
}

function fanoutArchiveDualEmit(input: ArchiveDualEmitInput) {
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

interface UnarchiveDualEmitInput {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}

function fanoutUnarchiveDualEmit(input: UnarchiveDualEmitInput) {
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

export const taskHandlers: ServerRpcSlots = [
  defineTaskMethod(TaskList, {
    callablePrincipal: "agent",
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const taskService = yield* TaskServiceTag;
        const { tasks, nextCursor } = yield* taskService
          .list(ctx.agentId, {
            limit: params.limit,
            cursor: params.cursor,
          })
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
      }).pipe(Effect.withSpan("task.list")),
  }),

  defineAppMethod(TaskClose, {
    callablePrincipal: "app",
    handler: (params, ctx) =>
      Effect.gen(function* () {
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
      }).pipe(Effect.withSpan("task.close")),
  }),

  defineAppMethod(TaskAddParticipant, {
    callablePrincipal: "app",
    handler: (params, ctx) =>
      Effect.gen(function* () {
        yield* assertCallerAppOwnsTask(ctx.appId, params.taskId);
        const taskService = yield* TaskServiceTag;
        const participant = yield* taskService.addParticipant(
          params.taskId,
          params.agentId,
        );
        return { participant };
      }).pipe(Effect.withSpan("task.addParticipant")),
  }),

  defineAppMethod(TaskRemoveParticipant, {
    callablePrincipal: "app",
    handler: (params, ctx) =>
      Effect.gen(function* () {
        yield* assertCallerAppOwnsTask(ctx.appId, params.taskId);
        const taskService = yield* TaskServiceTag;
        yield* taskService.removeParticipant(params.taskId, params.agentId);
        return {};
      }).pipe(Effect.withSpan("task.removeParticipant")),
  }),

  // `task/*` + `task/conversation/*` handlers. Per-flow walkthrough
  // lives in the family-overview header block in
  // `packages/protocol/src/task/tasks.ts` (the `task/*` +
  // `task/conversation/*` block above `InitialConversationSchema`).
  //
  // The 8 task-admin RPCs bind at the app layer (D #705 R7): each handler
  // runs `assertCallerAppOwnsTask` (the app-arm authority gate that replaced
  // the dissolved `TmAuthority` capability) before any service mutation. The
  // four conversation-targeted RPCs bind via `defineAppMiddlewareMethod` and
  // weave `ConversationInTask` as a `CapabilityMiddleware`; the rest are
  // cap-less (`defineAppMethod`).

  // `task/request` is registered via `defineAppMiddlewareMethod` in
  // `packages/server/src/app/handlers/task-request.handler.ts`. The
  // descriptor stays in `@moltzap/protocol/task`; the binding moves up
  // a layer because the handler needs `AppHostTag` to fire the
  // `task/create` TM callback (an app-layer service).

  defineTaskMethod(TaskLeave, {
    callablePrincipal: "agent",
    requiresActive: true,
    handler: (params, ctx) => taskLeaveBody(params, ctx),
  }),

  defineAppMethod(TaskConversationCreate, {
    callablePrincipal: "app",
    handler: (params, ctx) => taskConversationCreateBody(ctx.appId, params),
  }),

  defineTaskMethod(TaskConversationList, {
    callablePrincipal: "agent",
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const conversationService = yield* ConversationServiceTag;
        // `archived: "include"` per spec body Goal 1 — archived rows
        // are surfaced and the client filters `conversation.archivedAt`
        // locally. The underlying `listConversations` helper already
        // supports the `include` filter mode (Spec E added it).
        const { conversations, cursor: nextCursor } =
          yield* conversationService.list(
            ctx.agentId,
            params.limit,
            params.cursor,
            "include",
          );
        // Project each summary into the spec-body `TaskConversationListItem`
        // shape: `{ taskId, conversation: ConversationRow, participants }`.
        // The summary is from the listConversations projection; the per-
        // item `conversation` and `participants` come from one batched
        // round-trip each.
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
        return {
          items,
          ...(nextCursor !== undefined ? { nextCursor } : {}),
        };
      }).pipe(Effect.withSpan("task.conversation.list")),
  }),

  defineAppMiddlewareMethod(
    TaskConversationArchive,
    [conversationInTaskForArchive] as const,
    {
      callablePrincipal: "app",
      handler: (params, ctx) =>
        Effect.gen(function* () {
          yield* assertCallerAppOwnsTask(ctx.appId, params.taskId);
          // `ConversationInTask` woven by `weaveCaps`; consumed inside
          // `archiveTaskConversation`.
          const taskService = yield* TaskServiceTag;
          const { archivedAt } = yield* taskService.archiveTaskConversation(
            params.taskId,
            params.conversationId,
          );
          yield* fanoutArchiveDualEmit({
            taskId: params.taskId,
            conversationId: params.conversationId,
            archivedAt,
          });
          return {};
        }).pipe(Effect.withSpan("task.conversation.archive")),
      weaveCaps: (handlerEffect, params) =>
        handlerEffect.pipe(
          provideMiddleware(conversationInTaskForArchive, params),
        ),
    },
  ),

  defineAppMiddlewareMethod(
    TaskConversationUnarchive,
    [conversationInTaskForUnarchive] as const,
    {
      callablePrincipal: "app",
      handler: (params, ctx) =>
        Effect.gen(function* () {
          yield* assertCallerAppOwnsTask(ctx.appId, params.taskId);
          // `ConversationInTask` woven by `weaveCaps`; consumed inside
          // `unarchiveTaskConversation`.
          const taskService = yield* TaskServiceTag;
          yield* taskService.unarchiveTaskConversation(
            params.taskId,
            params.conversationId,
          );
          yield* fanoutUnarchiveDualEmit({
            taskId: params.taskId,
            conversationId: params.conversationId,
          });
          return {};
        }).pipe(Effect.withSpan("task.conversation.unarchive")),
      weaveCaps: (handlerEffect, params) =>
        handlerEffect.pipe(
          provideMiddleware(conversationInTaskForUnarchive, params),
        ),
    },
  ),

  defineAppMiddlewareMethod(
    TaskConversationAddParticipant,
    [conversationInTaskForAddParticipant] as const,
    {
      callablePrincipal: "app",
      handler: (params, ctx) =>
        Effect.gen(function* () {
          // App-ownership gate first — same rationale as
          // `taskConversationCreateBody` (so a non-owner sees
          // ForbiddenError before `requireAgentsAreInTaskParticipants`
          // can leak task-state).
          yield* assertCallerAppOwnsTask(ctx.appId, params.taskId);
          const taskService = yield* TaskServiceTag;
          // Participant-admitted invariant — runs AFTER app-ownership auth.
          yield* taskService.requireAgentsAreInTaskParticipants(params.taskId, [
            params.agentId,
          ]);
          // `ConversationInTask` woven by `weaveCaps`; consumed inside
          // `addTaskConversationParticipant`.
          const { postMutationParticipants } =
            yield* taskService.addTaskConversationParticipant(
              params.taskId,
              params.conversationId,
              params.agentId,
            );
          // Post-mutation membership drives fan-out so the newcomer
          // receives their own added notification.
          yield* broadcastNotificationToAgents(
            postMutationParticipants,
            TaskConversationParticipantsAddedNotificationDefinition,
            {
              taskId: params.taskId,
              conversationId: params.conversationId,
              addedAgentId: params.agentId,
              byAgentOrTm: "tm" as const,
            },
          );
          return {};
        }).pipe(Effect.withSpan("task.conversation.participants.add")),
      weaveCaps: (handlerEffect, params) =>
        handlerEffect.pipe(
          provideMiddleware(conversationInTaskForAddParticipant, params),
        ),
    },
  ),

  defineAppMiddlewareMethod(
    TaskConversationRemoveParticipant,
    [conversationInTaskForRemoveParticipant] as const,
    {
      callablePrincipal: "app",
      handler: (params, ctx) =>
        Effect.gen(function* () {
          yield* assertCallerAppOwnsTask(ctx.appId, params.taskId);
          // `ConversationInTask` woven by `weaveCaps`; consumed inside
          // `removeTaskConversationParticipant`.
          const taskService = yield* TaskServiceTag;
          const { preMutationParticipants, wasParticipant } =
            yield* taskService.removeTaskConversationParticipant(
              params.taskId,
              params.conversationId,
              params.agentId,
            );
          if (!wasParticipant) {
            // Idempotent no-op: no notifications fire when the agent was
            // not in `conversation_participants`.
            return {};
          }
          // Pre-mutation membership drives fan-out so the removed agent
          // still receives the notification.
          yield* broadcastNotificationToAgents(
            preMutationParticipants,
            TaskConversationParticipantsRemovedNotificationDefinition,
            {
              taskId: params.taskId,
              conversationId: params.conversationId,
              removedAgentId: params.agentId,
              reason: "tm_remove" as const,
            },
          );
          return {};
        }).pipe(Effect.withSpan("task.conversation.participants.remove")),
      weaveCaps: (handlerEffect, params) =>
        handlerEffect.pipe(
          provideMiddleware(conversationInTaskForRemoveParticipant, params),
        ),
    },
  ),
];
