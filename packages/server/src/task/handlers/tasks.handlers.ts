import { Effect } from "effect";
import {
  DEFAULT_APP_ID,
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
  TaskCreate,
  TaskLeave,
  TaskAddParticipant,
  TaskClose,
  TaskList,
  TaskRemoveParticipant,
  type Conversation,
  type ParamsOf,
  type Task,
  type TaskConversationListItem,
} from "@moltzap/protocol";
import type { ConversationId, TaskId } from "@moltzap/protocol/task";
import { defaultAppTmEndpointAddress } from "../../task/services/task.service.js";
import { defineTaskMethod } from "../../transport/define-layered-method.js";
import type { RpcMethodRegistry } from "../../transport/context.js";
import type { AgentId } from "../../app/types.js";
import { ConversationServiceTag, TaskServiceTag } from "../../app/layers.js";
import { ContactPolicyAllowsReach, TmAuthority } from "@moltzap/protocol/task";
import { broadcastNotificationToAgents } from "./notification-broadcast.js";

function maybeTaskCreateDedup(
  taskService: TaskServiceShape,
  params: ParamsOf<typeof TaskCreate>,
  ctx: { readonly agentId: AgentId },
) {
  return Effect.gen(function* () {
    if (params.appId !== DEFAULT_APP_ID) return null;
    const existing = yield* taskService.findExistingTaskByParticipants(
      ctx.agentId,
      params.invitedAgentIds,
      params.appId,
    );
    return existing === null
      ? null
      : { task: existing, conversation: null as Conversation | null };
  }).pipe(Effect.withSpan("task.create.dedup"));
}

type TaskServiceShape = Effect.Effect.Success<typeof TaskServiceTag>;

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
    // `ConversationCreateAuthorization` is auto-provisioned by the
    // dispatcher via TaskCreate.capabilities — the obtain is consumed
    // lazily here by `conversationService.create`.
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
      TaskConversationCreatedNotificationDefinition,
      {
        taskId: input.task.id,
        conversationId: conversation.id,
        name: input.initial.name,
        participants: [...participantAgentIds],
      },
    );
    return { task: input.task, conversation };
  }).pipe(Effect.withSpan("task.create.mintInitialConversation"));
}

interface TaskConversationCreateInput {
  readonly taskId: TaskId;
  readonly conversation: Conversation;
  readonly participants: ReadonlyArray<AgentId>;
  readonly name?: string;
}

function fanoutTaskConversationCreate(input: TaskConversationCreateInput) {
  // Recipients = the initial participants. The TM caller is NOT a
  // `conversation_participants` row under the TM-only authority model,
  // so it is not in the fan-out.
  return broadcastNotificationToAgents(
    input.participants,
    TaskConversationCreatedNotificationDefinition,
    {
      taskId: input.taskId,
      conversationId: input.conversation.id,
      name: input.name,
      participants: [...input.participants],
    },
  ).pipe(Effect.withSpan("task.conversation.create.fanout"));
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
  readonly by: AgentId;
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
  readonly by: AgentId;
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

export const taskHandlers: RpcMethodRegistry = [
  defineTaskMethod(TaskList, {
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const taskService = yield* TaskServiceTag;
        const tasks = yield* taskService.list(ctx.agentId, {
          limit: params.limit,
        });
        return { tasks: [...tasks] };
      }).pipe(Effect.withSpan("task.list")),
  }),

  defineTaskMethod(TaskClose, {
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

  defineTaskMethod(TaskAddParticipant, {
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const taskService = yield* TaskServiceTag;
        const participant = yield* taskService.addParticipant(
          params.taskId,
          ctx.agentId,
          params.agentId,
        );
        return { participant };
      }).pipe(Effect.withSpan("task.addParticipant")),
  }),

  defineTaskMethod(TaskRemoveParticipant, {
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const taskService = yield* TaskServiceTag;
        yield* taskService.removeParticipant(
          params.taskId,
          ctx.agentId,
          params.agentId,
        );
        return {};
      }).pipe(Effect.withSpan("task.removeParticipant")),
  }),

  // `task/*` + `task/conversation/*` handlers. Per-flow walkthrough:
  // `packages/protocol/docs/architecture/task-conversation-family.md`.
  //
  // Capability tags are declared on each descriptor's `capabilities: [...]`
  // and auto-provisioned by the dispatcher; handler bodies just call the
  // service method whose R channel yields the tag.
  //
  // `TaskConversationCreate` and `TaskConversationAddParticipant`
  // explicitly `yield* TmAuthority` before any inline gate so a non-TM
  // caller sees `ForbiddenError` instead of `ParticipantNotAdmittedError`
  // (which would leak task state).

  defineTaskMethod(TaskCreate, {
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const taskService = yield* TaskServiceTag;
        const existing = yield* maybeTaskCreateDedup(taskService, params, ctx);
        if (existing !== null) return existing;
        // Force the auto-provisioned contact-policy check to run before
        // the task row is written. Dedup short-circuits above; on a fresh
        // create we always need the policy gate.
        yield* ContactPolicyAllowsReach;
        const task = yield* taskService.create(ctx.agentId, {
          appId: params.appId,
          invitedAgentIds: params.invitedAgentIds,
          tmEndpointAddress: defaultAppTmEndpointAddress(params.appId),
        });
        if (params.initialConversation === undefined) {
          return { task, conversation: null as Conversation | null };
        }
        return yield* mintInitialConversation({
          task,
          initial: params.initialConversation,
          invitedAgentIds: params.invitedAgentIds,
          callerAgentId: ctx.agentId,
        });
      }).pipe(Effect.withSpan("task.create")),
  }),

  defineTaskMethod(TaskLeave, {
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        const taskService = yield* TaskServiceTag;
        const { leftConversationIds, closedTask } =
          yield* taskService.leaveTask(params.taskId, ctx.agentId);
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
      }).pipe(Effect.withSpan("task.leave")),
  }),

  defineTaskMethod(TaskConversationCreate, {
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        // Auth before participant-admitted check so a non-TM caller sees
        // ForbiddenError, not ParticipantNotAdmittedError (which leaks
        // task state). The descriptor declares the tag lazily; an
        // explicit yield forces obtainTmAuthority to run up front.
        yield* TmAuthority;
        const taskService = yield* TaskServiceTag;
        const conversationService = yield* ConversationServiceTag;
        yield* taskService.requireAgentsAreInTaskParticipants(
          params.taskId,
          params.participants,
        );
        const conversation = yield* conversationService.create({
          name: params.name,
          agentIds: [...params.participants],
          creatorAgentId: ctx.agentId,
          mintTask: Effect.succeed({ id: params.taskId }),
        });
        yield* fanoutTaskConversationCreate({
          taskId: params.taskId,
          conversation,
          participants: params.participants,
          name: params.name,
        });
        return { conversation };
      }).pipe(Effect.withSpan("task.conversation.create")),
  }),

  defineTaskMethod(TaskConversationList, {
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

  defineTaskMethod(TaskConversationArchive, {
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        // `TmAuthority` + `ConversationInTask` auto-provisioned per
        // descriptor `capabilities: [...]`; consumed inside
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
          by: ctx.agentId,
        });
        return {};
      }).pipe(Effect.withSpan("task.conversation.archive")),
  }),

  defineTaskMethod(TaskConversationUnarchive, {
    requiresActive: true,
    handler: (params, ctx) =>
      Effect.gen(function* () {
        // `TmAuthority` + `ConversationInTask` auto-provisioned per
        // descriptor `capabilities: [...]`; consumed inside
        // `unarchiveTaskConversation`.
        const taskService = yield* TaskServiceTag;
        yield* taskService.unarchiveTaskConversation(
          params.taskId,
          params.conversationId,
        );
        yield* fanoutUnarchiveDualEmit({
          taskId: params.taskId,
          conversationId: params.conversationId,
          by: ctx.agentId,
        });
        return {};
      }).pipe(Effect.withSpan("task.conversation.unarchive")),
  }),

  defineTaskMethod(TaskConversationAddParticipant, {
    requiresActive: true,
    handler: (params) =>
      Effect.gen(function* () {
        // Auth-first invariant — same rationale as the
        // `TaskConversationCreate` handler above (the explicit yield
        // forces the dispatcher's lazy `provideServiceEffect` to run
        // the obtain helper before `requireAgentsAreInTaskParticipants`
        // can leak task-state to a non-TM caller).
        yield* TmAuthority;
        const taskService = yield* TaskServiceTag;
        // Participant-admitted invariant — runs AFTER TM auth.
        yield* taskService.requireAgentsAreInTaskParticipants(params.taskId, [
          params.agentId,
        ]);
        // `ConversationInTask` auto-provisioned per descriptor and
        // consumed inside `addTaskConversationParticipant`. `TmAuthority`
        // already resolved above (cached in the provisioned context, so
        // the obtain helper does not re-run).
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
  }),

  defineTaskMethod(TaskConversationRemoveParticipant, {
    requiresActive: true,
    handler: (params) =>
      Effect.gen(function* () {
        // `TmAuthority` + `ConversationInTask` auto-provisioned per
        // descriptor `capabilities: [...]`; consumed inside
        // `removeTaskConversationParticipant`. No inline gate runs
        // before the service call, so an explicit up-front
        // `yield* TmAuthority` is unnecessary here (auth runs at the
        // service body's `yield* TmAuthority`).
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
  }),
];
