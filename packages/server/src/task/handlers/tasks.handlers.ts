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
  inferConversationType,
  TaskAddParticipant,
  TaskClose,
  TaskList,
  TaskRemoveParticipant,
  type AppId,
  type Conversation,
  type Task,
  type TaskConversationListItem,
} from "@moltzap/protocol";
import type { ConversationId, TaskId } from "@moltzap/protocol/task";
import { defaultAppTmEndpointAddress } from "../../task/services/task.service.js";
import { defineTaskMethod } from "../../transport/define-layered-method.js";
import type { RpcMethodRegistry } from "../../transport/context.js";
import type { AgentId } from "../../app/types.js";
import { ConversationServiceTag, TaskServiceTag } from "../../app/layers.js";
// D1 uses three capability surfaces directly:
//   - `TmAuthority` — explicit `yield*` in two handlers to force the
//     dispatcher's lazy `provideServiceEffect` to evaluate the obtain
//     helper BEFORE the participant-admitted invariant runs (auth-first
//     guarantee per per-flow doc §"Capability list per new handler").
//   - `obtainContactPolicyForCreate` — inline-yielded in `taskCreateBody`
//     ONLY when `invitedAgentIds` is non-empty; the conditional shape
//     means it can't fit the descriptor's unconditional `capabilities:
//     [...]` array.
//   - `ConversationCreateAuthorization` + `obtainConversationCreateAuthorization`
//     — hand-piped via `Effect.provideServiceEffect` inside
//     `mintInitialConversation` ONLY when `initialConversation` is
//     supplied; same conditional rationale.
// The four other capability tags consumed by D1 service methods
// (`TmAuthority` + `ConversationInTask` for archive/unarchive/add/remove
// participant, and `ConversationCreateAuthorization` for the
// non-conditional `task/conversation/create` path) are auto-provisioned
// by the dispatcher per the descriptor `capabilities: [...]` arrays in
// `@moltzap/protocol/task/tasks.ts`.
import {
  ConversationCreateAuthorization,
  TmAuthority,
  obtainContactPolicyForCreate,
  obtainConversationCreateAuthorization,
} from "../../app/capabilities/index.js";
import { broadcastNotificationToAgents } from "./notification-broadcast.js";

/**
 * Spec D1 (#598) `task/create` body — extracted out of the
 * `defineTaskMethod` arrow to fit the package's
 * `max-lines-per-function` cap. The handler delegates here; this
 * function owns dedup + atomic-initial-conversation orchestration
 * across `taskService.create` + `conversationService.create` and
 * the dual-emit notification fan-out per architect plan §"Dual
 * emission during D1".
 */
function taskCreateBody(
  params: {
    readonly appId: AppId;
    readonly invitedAgentIds: ReadonlyArray<AgentId>;
    readonly initialConversation?: {
      readonly name?: string;
      readonly participants?: ReadonlyArray<AgentId>;
    };
  },
  ctx: { readonly agentId: AgentId },
) {
  return Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const existing = yield* maybeTaskCreateDedup(taskService, params, ctx);
    if (existing !== null) return existing;
    yield* maybeRunContactPolicyForTaskCreate(params, ctx);
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
  }).pipe(Effect.withSpan("task.create"));
}

type TaskCreateParams = Parameters<typeof taskCreateBody>[0];
type TaskCreateCtx = Parameters<typeof taskCreateBody>[1];

function maybeTaskCreateDedup(
  taskService: TaskServiceShape,
  params: TaskCreateParams,
  ctx: TaskCreateCtx,
) {
  return Effect.gen(function* () {
    if (params.appId !== DEFAULT_APP_ID) return null;
    const existing = yield* taskService.findExistingTaskByParticipants(
      ctx.agentId,
      params.invitedAgentIds,
      params.appId,
    );
    // Dedup is task-level (spec body Goal 3): no fresh conversation
    // even when `initialConversation` is supplied. The contact-policy
    // gate is NOT applied on dedup hit — the extant task's participant
    // set was authorized at its original create time.
    return existing === null
      ? null
      : { task: existing, conversation: null as Conversation | null };
  }).pipe(Effect.withSpan("task.create.dedup"));
}

function maybeRunContactPolicyForTaskCreate(
  params: TaskCreateParams,
  ctx: TaskCreateCtx,
) {
  if (params.invitedAgentIds.length === 0) return Effect.void;
  // Per per-flow doc §"Capability list per new handler" — `TaskCreate`
  // declares `[ContactPolicyAllowsReach]` only when `invitedAgentIds`
  // is non-empty (a self-only task is exempt; there are no targets to
  // reach). The obtain helper surfaces `NotInContactsError` /
  // `NotFoundError` / `ForbiddenError` if any caller -> target edge
  // fails.
  const inferredType: "dm" | "group" =
    params.initialConversation !== undefined &&
    1 +
      (params.initialConversation.participants ?? params.invitedAgentIds)
        .length ===
      2
      ? "dm"
      : "group";
  return obtainContactPolicyForCreate(
    ctx.agentId,
    params.invitedAgentIds,
    inferredType,
  );
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
    const inferredType = inferConversationType(participantAgentIds);
    const conversation = yield* conversationService
      .create({
        type: inferredType,
        name: input.initial.name,
        agentIds: [...participantAgentIds],
        creatorAgentId: input.callerAgentId,
        mintTask: Effect.succeed({ id: input.task.id }),
      })
      .pipe(
        Effect.provideServiceEffect(
          ConversationCreateAuthorization,
          obtainConversationCreateAuthorization({
            type: inferredType,
            agentIds: [...participantAgentIds],
            creatorAgentId: input.callerAgentId,
          }),
        ),
      );
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

function taskConversationCreateBody(
  params: {
    readonly taskId: TaskId;
    readonly name?: string;
    readonly participants: ReadonlyArray<AgentId>;
  },
  ctx: { readonly agentId: AgentId },
) {
  return Effect.gen(function* () {
    // Authority FIRST per per-flow doc §"Capability list per new
    // handler" — proves the caller is the TM before any other gate
    // observes task state. The descriptor declares `[TmAuthority,
    // ConversationCreateAuthorization]`, but the dispatcher provisions
    // tags via lazy `provideServiceEffect`. Forcing the yield here
    // executes `obtainTmAuthority` BEFORE
    // `requireAgentsAreInTaskParticipants` so a non-TM caller MUST get
    // `ForbiddenError` rather than `ParticipantNotAdmittedError` (the
    // participant-admitted invariant is a side-channel for task state
    // and must stay behind the auth gate).
    yield* TmAuthority;
    const taskService = yield* TaskServiceTag;
    const conversationService = yield* ConversationServiceTag;
    // Spec D1 invariant: every participant MUST already appear in
    // `task_participants` for `taskId`. Per-flow doc §"Participant
    // invariant" — admitted-OR-pending both pass; missing fails with
    // `ParticipantNotAdmittedError`. Runs AFTER TM auth so the tag
    // is only observable to authorized callers.
    yield* taskService.requireAgentsAreInTaskParticipants(
      params.taskId,
      params.participants,
    );
    const inferredType = inferConversationType(params.participants);
    // `ConversationCreateAuthorization` is auto-provisioned by the
    // descriptor's `argsOf` and consumed inside `conversationService.create`.
    const conversation = yield* conversationService.create({
      type: inferredType,
      name: params.name,
      agentIds: [...params.participants],
      creatorAgentId: ctx.agentId,
      mintTask: Effect.succeed({ id: params.taskId }),
    });
    yield* fanoutTaskConversationCreateDualEmit({
      taskId: params.taskId,
      conversation,
      participants: params.participants,
      name: params.name,
    });
    return { conversation };
  }).pipe(Effect.withSpan("task.conversation.create"));
}

interface TaskConversationCreateDualEmitInput {
  readonly taskId: TaskId;
  readonly conversation: Conversation;
  readonly participants: ReadonlyArray<AgentId>;
  readonly name?: string;
}

function fanoutTaskConversationCreateDualEmit(
  input: TaskConversationCreateDualEmitInput,
) {
  return Effect.gen(function* () {
    // Recipients per per-flow doc §"Notifications" → "Recipients
    // (impl-staff target)" table: "initial `participants` list".
    // The caller is the TM (NOT a `conversation_participants` row
    // under D1's TM-only authority model), so the caller is NOT
    // included in the fan-out — even though the legacy
    // `ConversationsCreate` path auto-included the caller because
    // the legacy creator WAS a participant. D1 removes that
    // implicit self-include.
    const recipientAgentIds: ReadonlyArray<AgentId> = input.participants;
    yield* broadcastNotificationToAgents(
      recipientAgentIds,
      TaskConversationCreatedNotificationDefinition,
      {
        taskId: input.taskId,
        conversationId: input.conversation.id,
        name: input.name,
        participants: [...input.participants],
      },
    );
  }).pipe(Effect.withSpan("task.conversation.create.fanout"));
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

  // ───────────────────────────────────────────────────────────────────
  // Spec D1 (#598) — additive `task/*` + `task/conversation/*` family.
  //
  // Handlers below coexist with the legacy `tasks/*` and `conversations/*`
  // bindings above for the transitional window. Spec D3 (#600) deletes
  // the legacy handlers + dual-emission inside the same orchestration
  // (parent epic #602).
  //
  // Per-flow walkthroughs:
  //   packages/protocol/docs/architecture/task-conversation-family.md
  //
  // Capability shape (post-Spec-F #632 typed-dispatcher cutover): every
  // TM-gated descriptor in `@moltzap/protocol/task/tasks.ts` declares
  // its capability tags in `capabilities: [...]`. The dispatcher
  // auto-provisions each tag via lazy `Effect.provideServiceEffect`
  // per frame from the shared `serverCapabilityProviders` table; handler
  // bodies just call the service method whose R channel yields the
  // tag. The per-flow doc's "Capability list per new handler" table
  // remains the source of truth for which tags each descriptor declares.
  //
  // Two handlers explicitly `yield* TmAuthority` before any inline
  // gate that could leak state (`requireAgentsAreInTaskParticipants`):
  // `TaskConversationCreate` and `TaskConversationAddParticipant`.
  // The explicit yield forces the lazy obtain helper to execute up
  // front so a non-TM caller sees `ForbiddenError` rather than
  // `ParticipantNotAdmittedError` (auth-first invariant per
  // codex review N=1).
  // ───────────────────────────────────────────────────────────────────

  defineTaskMethod(TaskCreate, {
    requiresActive: true,
    handler: (params, ctx) => taskCreateBody(params, ctx),
  }),

  defineTaskMethod(TaskLeave, {
    requiresActive: true,
    handler: (params, ctx) => taskLeaveBody(params, ctx),
  }),

  defineTaskMethod(TaskConversationCreate, {
    requiresActive: true,
    handler: (params, ctx) => taskConversationCreateBody(params, ctx),
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
        // Auth-first invariant — same rationale as
        // `taskConversationCreateBody` (the explicit yield forces the
        // dispatcher's lazy `provideServiceEffect` to run the obtain
        // helper before `requireAgentsAreInTaskParticipants` can leak
        // task-state to a non-TM caller).
        yield* TmAuthority;
        const taskService = yield* TaskServiceTag;
        // Spec D1 participant-admitted invariant — runs AFTER TM auth.
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
