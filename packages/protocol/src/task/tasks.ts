import { Data } from "effect";
import { Type, type Static } from "@sinclair/typebox";
import {
  stringEnum,
  dateTimeStringSchema,
  listCursorSchema,
} from "../schema-primitives.js";
import { ListLimitSchema } from "../pagination.js";
import { AgentId } from "../identity/agents.js";
import { defineRpc, defineNotification } from "../transport/method.js";
import {
  registerErrorClass,
  type RpcErrorPayload,
} from "../transport/wire-errors.js";
import { ConversationId, conversationSchema } from "./conversations.js";
import { AppId, TaskId } from "./ids.js";
// #705 HALF-2 — `task/request`'s `ContactPolicyAllowsReach` and the four
// `task/conversation/*` `ConversationInTask` capabilities are declared at
// the server binding site as `CapabilityMiddleware` tuples (reading the
// caller via `CurrentPrincipal`), NOT as descriptor `capabilities` + `argsOf`
// resolvers. The wire descriptors below carry only their params/result shape.

// `AppId` / `DEFAULT_APP_ID` / `TaskId` are defined in `./ids.ts` and
// re-exported here for backward compatibility of import paths.
export { AppId, DEFAULT_APP_ID, TaskId } from "./ids.js";

const DateTimeString = dateTimeStringSchema();
const ConversationSchema = conversationSchema();

export class TaskClosedError extends Data.TaggedError(
  "TaskClosed",
)<RpcErrorPayload> {
  static readonly code = -32020;
  static readonly message = "Task is closed";
}
registerErrorClass(TaskClosedError);

/**
 * `task/request` failed because the bound TM rejected the
 * server-initiated `task/create` callback (or the fail-closed
 * envelope synthesized a reject on timeout / RPC error / decode
 * failure). The tag lets a requester distinguish "my task was
 * rejected by the moderator" — an expected, actionable outcome —
 * from an opaque internal error. The TM's reason rides in the
 * `data` arm when present.
 */
export class TaskRejectedError extends Data.TaggedError(
  "TaskRejected",
)<RpcErrorPayload> {
  static readonly code = -32024;
  static readonly message = "Task request was rejected by the task manager";
}
registerErrorClass(TaskRejectedError);

export class HookBlockedError extends Data.TaggedError(
  "HookBlocked",
)<RpcErrorPayload> {
  static readonly code = -32019;
  static readonly message = "Hook blocked the dispatch";
}
registerErrorClass(HookBlockedError);

/**
 * `task/conversation/create` and `task/conversation/participants/add`
 * reject agents who are not already in `task_participants`. The error
 * tag lets clients distinguish "wrong agentId shape" (InvalidParams)
 * from "agent exists but is not admitted to this task" (this tag)
 * without parsing message strings.
 */
export class ParticipantNotAdmittedError extends Data.TaggedError(
  "ParticipantNotAdmitted",
)<RpcErrorPayload> {
  static readonly code = -32023;
  static readonly message = "Agent is not admitted to the task";
}
registerErrorClass(ParticipantNotAdmittedError);

/**
 * Logical time frontier per delivery domain (usually a conversation):
 * monotonic `epoch` + per-participant observed counts in `vector`.
 */
const LogicalClockSchema = Type.Object(
  {
    domainId: Type.String({ minLength: 1 }),
    epoch: Type.Integer({ minimum: 0 }),
    vector: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export type LogicalClock = Static<typeof LogicalClockSchema>;

export function logicalClockSchema(): typeof LogicalClockSchema {
  return LogicalClockSchema;
}

// Mirrors the `task_status` DB enum.
const TaskStatusEnum = stringEnum(["waiting", "active", "failed", "closed"]);

export type TaskStatus = Static<typeof TaskStatusEnum>;

const TaskSchema = Type.Object(
  {
    id: TaskId,
    appId: Type.String(),
    initiatorAgentId: AgentId,
    status: TaskStatusEnum,
    startedAt: Type.Union([DateTimeString, Type.Null()]),
    endedAt: Type.Union([DateTimeString, Type.Null()]),
    createdAt: DateTimeString,
  },
  { additionalProperties: false },
);

export type Task = Static<typeof TaskSchema>;

// `admittedAt = null` is reserved for a future "pending invitation"
// flow. Today the server auto-admits every invitee at TaskRequest, so
// the field is always non-null on the wire. The column is kept
// nullable + the `WHERE admitted_at IS NOT NULL` filters in read
// paths stay in place so the future flow drops in without
// re-engineering the gating.
const TaskParticipantSchema = Type.Object(
  {
    taskId: TaskId,
    agentId: AgentId,
    admittedAt: Type.Union([DateTimeString, Type.Null()]),
  },
  { additionalProperties: false },
);

export type TaskParticipant = Static<typeof TaskParticipantSchema>;

export const TaskList = defineRpc({
  name: "task/list",
  params: Type.Object(
    {
      limit: ListLimitSchema,
      cursor: Type.Optional(listCursorSchema()),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      tasks: Type.Array(TaskSchema),
      nextCursor: Type.Optional(listCursorSchema()),
    },
    { additionalProperties: false },
  ),
});

export const TaskClose = defineRpc({
  name: "task/close",
  params: Type.Object({ taskId: TaskId }, { additionalProperties: false }),
  result: Type.Object({ task: TaskSchema }, { additionalProperties: false }),
});

export const TaskAddParticipant = defineRpc({
  name: "task/addParticipant",
  params: Type.Object(
    {
      taskId: TaskId,
      agentId: AgentId,
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { participant: TaskParticipantSchema },
    { additionalProperties: false },
  ),
});

export const TaskRemoveParticipant = defineRpc({
  name: "task/removeParticipant",
  params: Type.Object(
    {
      taskId: TaskId,
      agentId: AgentId,
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

const TaskFailedNotificationSchema = Type.Object(
  {
    taskId: TaskId,
    // Free-form one-liner. The task/create TM-callback verdict's
    // `reject.reason`, the synthesized `"tm_unreachable"` /
    // `"timeout"` strings from the fail-closed envelope, and any
    // future caller-supplied failure reason all flow through here.
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  },
  { additionalProperties: false },
);

const TaskCreatedNotificationSchema = Type.Object(
  { task: TaskSchema },
  { additionalProperties: false },
);

const TaskClosedNotificationSchema = Type.Object(
  { task: TaskSchema },
  { additionalProperties: false },
);

/**
 * Pushed when a task fails before becoming ready.
 * @triggeredBy task/create
 */
export const TaskFailedNotificationDefinition = defineNotification({
  name: "task/failed",
  params: TaskFailedNotificationSchema,
});

/**
 * Pushed to the task initiator + invited participants after the TM
 * accepts via the `task/create` wire callback and the task
 * transitions from `waiting` to `active`. Carries the full Task row
 * (matching `task/closed`'s shape) so subscribers don't need a
 * second read to discover the post-transition state.
 */
export const TaskCreatedNotificationDefinition = defineNotification({
  name: "task/created",
  params: TaskCreatedNotificationSchema,
});

/**
 * Pushed when a task closes.
 * @triggeredBy task/close
 */
export const TaskClosedNotificationDefinition = defineNotification({
  name: "task/closed",
  params: TaskClosedNotificationSchema,
});

// ─────────────────────────────────────────────────────────────────────
// `task/*` + `task/conversation/*` — the task-scoped admin surface.
//
// A task is the unit of admission: every conversation under a task
// draws its participant pool from `task_participants`, and the task's
// owning app's TM (task manager) is the gatekeeper for membership
// changes.
//
// Layout:
//   - `task/create` / `task/leave` — task-level lifecycle.
//   - `task/conversation/*` — conversation lifecycle under a task.
//   - `task/conversation/participants/*` — membership inside a
//     specific conversation.
//
// Authority gates:
//
// | Method                                  | Authority                                |
// |-----------------------------------------|------------------------------------------|
// | TaskCreate                              | any authenticated agent + contact-policy |
// | TaskLeave                               | self only                                |
// | TaskConversationCreate                  | TM + participant-admitted invariant      |
// | TaskConversationList                    | self only (caller in conversation)       |
// | TaskConversationArchive / Unarchive     | TM only                                  |
// | TaskConversationAddParticipant          | TM + participant-admitted invariant      |
// | TaskConversationRemoveParticipant       | TM only                                  |
//
// Participant-admitted invariant (`TaskConversationCreate`,
// `TaskConversationAddParticipant`): every agent listed in
// `participants` MUST already appear in `task_participants` for
// `taskId`. Conversations are scoped strictly within their task's
// admission set; missing rows fail with `ParticipantNotAdmittedError`.
//
// Authority (D #705 R7): the 8 task-admin RPCs bind via
// `defineAppMethod` and gate on `assertCallerAppOwnsTask` (the app-arm
// successor to the dissolved `TmAuthority` capability) BEFORE any
// participant probe — so a non-owner sees `ForbiddenError` rather than
// leaking task-membership existence through `ParticipantNotAdmittedError`.
// The four conversation-targeted descriptors share the
// `conversationInTaskArgsOfPair` builder for their lone surviving
// `ConversationInTask` capability.
//
// Atomicity: `task/create` with `initialConversation` commits the
// task row, then opens a separate transaction for the conversation
// insert. A conversation failure leaves the task row in place. Strict
// cross-call atomicity (single commit covering both rows) is not
// guaranteed.
//
// Notification emission: each mutating op enqueues notifications
// AFTER the row mutation returns. `task/create` with
// `initialConversation` emits one `task/conversation/created`.
// `task/leave` emits one
// `task/conversation/participants/removed { reason: "task_leave" }`
// per conversation the leaver was in, plus `task/closed` if the leave
// empties `task_participants`. Broadcast is best-effort: socket
// writes fork via `Effect.runFork` and do not roll back the DB write
// on delivery failure.
// ─────────────────────────────────────────────────────────────────────

const InitialConversationSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    participants: Type.Optional(Type.Array(AgentId, { minItems: 1 })),
  },
  { additionalProperties: false },
);

export type InitialConversationInput = Static<typeof InitialConversationSchema>;

const TaskConversationListItemSchema = Type.Object(
  {
    taskId: TaskId,
    conversation: ConversationSchema,
    participants: Type.Array(AgentId),
  },
  { additionalProperties: false },
);

export type TaskConversationListItem = Static<
  typeof TaskConversationListItemSchema
>;

/**
 * Open to any authenticated agent. Returns `{ task, conversation }`
 * where `conversation` is `null` when `initialConversation` is omitted.
 *
 * Dedup is a client-side concern: clients that want "one DM per
 * participant set" semantics list their tasks and filter locally
 * before creating a new one.
 *
 * NOTE (#683): the agent-facing entry RPC is `task/request`; the
 * TM-facing wire callback `task/create` lives in
 * `packages/protocol/src/app/methods.ts`. The server forks
 * `task/create` to the bound TM after inserting the task in
 * `waiting`; the TM's verdict drives the lifecycle (accept → active
 * + `task/created`; reject → failed + `task/failed`). The synchronous
 * `{ task, conversation }` result is returned after the verdict
 * resolves (the handler awaits it). A future ack-then-notify variant
 * could return `{ taskId }` immediately and let `task/created` /
 * `task/failed` carry the outcome; that is not the current shape.
 */
export const TaskRequest = defineRpc({
  name: "task/request",
  params: Type.Object(
    {
      appId: AppId,
      invitedAgentIds: Type.Array(AgentId),
      initialConversation: Type.Optional(InitialConversationSchema),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      task: TaskSchema,
      conversation: Type.Union([ConversationSchema, Type.Null()]),
    },
    { additionalProperties: false },
  ),
});

/**
 * Self-only: caller removes themselves from `task_participants` AND
 * every `conversation_participants` row under the task. See spec
 * body Goal 2 for the atomicity, idempotency, and
 * last-participant-task-closure contract.
 *
 * Notification emission for each conversation the caller leaves uses
 * `TaskConversationParticipantsRemovedNotificationDefinition` with
 * `reason: "task_leave"`. If removal empties `task_participants`
 * the task transitions to `status = 'closed'` and
 * `TaskClosedNotificationDefinition` fires alongside in the same
 * transaction.
 */
export const TaskLeave = defineRpc({
  name: "task/leave",
  params: Type.Object({ taskId: TaskId }, { additionalProperties: false }),
  result: Type.Object({}, { additionalProperties: false }),
});

/**
 * TM-only: mint a new conversation under an existing task. Every
 * entry in `participants` MUST already appear in `task_participants`
 * for `taskId`; violations return `ParticipantNotAdmittedError`.
 */
export const TaskConversationCreate = defineRpc({
  name: "task/conversation/create",
  params: Type.Object(
    {
      taskId: TaskId,
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      participants: Type.Array(AgentId, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { conversation: ConversationSchema },
    { additionalProperties: false },
  ),
  // No descriptor-side capabilities (D #705 R3/R7). App-ownership is
  // gated by the app-arm handler's `assertCallerAppOwnsTask`, and
  // `ConversationCreateAuthorization` is provided INLINE by the handler
  // as a capacity-only proof (a TM minting on the task's behalf has no
  // agent contact-edges; targets are gated by
  // `requireAgentsAreInTaskParticipants`).
});

/**
 * Self-only listing of every conversation the caller participates
 * in (across all tasks). No filter params; archived rows are
 * included; callers filter `archivedAt` locally. See spec body
 * Goal 1 for the full pagination + visibility contract.
 */
export const TaskConversationList = defineRpc({
  name: "task/conversation/list",
  params: Type.Object(
    {
      limit: ListLimitSchema,
      cursor: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      items: Type.Array(TaskConversationListItemSchema),
      nextCursor: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
});

// The four conversation-targeted descriptors below share the IDENTICAL
// `[ConversationInTask]` capability. App-ownership is gated in the app-arm
// handlers (D #705 R7); only `ConversationInTask` applies, declared at the
// server binding site as a `CapabilityMiddleware` (#705 HALF-2). The wire
// descriptors here carry only their params/result shape.

/** TM-only: archive one conversation. Task stays open. */
export const TaskConversationArchive = defineRpc({
  name: "task/conversation/archive",
  params: Type.Object(
    { taskId: TaskId, conversationId: ConversationId },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

/** TM-only: reverse of `task/conversation/archive`. */
export const TaskConversationUnarchive = defineRpc({
  name: "task/conversation/unarchive",
  params: Type.Object(
    { taskId: TaskId, conversationId: ConversationId },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

/**
 * TM-only: add an agent to one conversation. The agent MUST already
 * appear in `task_participants` for `taskId`; otherwise
 * `ParticipantNotAdmittedError`. Spec body Goal 1.
 */
export const TaskConversationAddParticipant = defineRpc({
  name: "task/conversation/participants/add",
  params: Type.Object(
    {
      taskId: TaskId,
      conversationId: ConversationId,
      agentId: AgentId,
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
  // App-ownership is gated by the app-arm handler's
  // `assertCallerAppOwnsTask` BEFORE `requireAgentsAreInTaskParticipants`
  // (so a non-owner sees `ForbiddenError`, not the participant-admitted
  // state probe). `ConversationInTask` is woven by the server binding's
  // `CapabilityMiddleware` (#705 HALF-2).
});

/**
 * TM-only: remove an agent from one conversation. The agent stays
 * in `task_participants` (so they may still receive messages on
 * other conversations within the task).
 */
export const TaskConversationRemoveParticipant = defineRpc({
  name: "task/conversation/participants/remove",
  params: Type.Object(
    {
      taskId: TaskId,
      conversationId: ConversationId,
      agentId: AgentId,
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

// ─── task/conversation/* notifications ──────────────────────────────
//
// Five events (spec body Goal 5; the `task/conversation/updated`
// entry in the dispatch brief is stale relative to the spec body —
// `TaskConversationUpdate` is explicitly NOT included per Goal 1).
//
// Recipient fan-out:
//   - `created` → initial `participants` list
//   - `archived` / `unarchived` → post-mutation `conversation_participants`
//   - `participants/added` → post-mutation membership (newcomer included)
//   - `participants/removed` → pre-mutation membership (so the removed
//     agent still receives the notification)
// ────────────────────────────────────────────────────────────────────

const TaskConversationCreatedNotificationSchema = Type.Object(
  {
    taskId: TaskId,
    conversationId: ConversationId,
    name: Type.Optional(Type.String()),
    participants: Type.Array(AgentId),
  },
  { additionalProperties: false },
);

const TaskConversationArchivedNotificationSchema = Type.Object(
  {
    taskId: TaskId,
    conversationId: ConversationId,
    archivedAt: DateTimeString,
  },
  { additionalProperties: false },
);

const TaskConversationUnarchivedNotificationSchema = Type.Object(
  { taskId: TaskId, conversationId: ConversationId },
  { additionalProperties: false },
);

const TaskConversationParticipantsAddedNotificationSchema = Type.Object(
  {
    taskId: TaskId,
    conversationId: ConversationId,
    addedAgentId: AgentId,
    // Authority is TM-only today; the enum is single-valued but kept
    // open-shaped so the wire can widen without a schema rev.
    byAgentOrTm: stringEnum(["tm"]),
  },
  { additionalProperties: false },
);

const TaskConversationParticipantsRemovedNotificationSchema = Type.Object(
  {
    taskId: TaskId,
    conversationId: ConversationId,
    removedAgentId: AgentId,
    reason: stringEnum(["tm_remove", "task_leave"]),
  },
  { additionalProperties: false },
);

export type TaskConversationCreatedNotification = Static<
  typeof TaskConversationCreatedNotificationSchema
>;
export type TaskConversationArchivedNotification = Static<
  typeof TaskConversationArchivedNotificationSchema
>;
export type TaskConversationUnarchivedNotification = Static<
  typeof TaskConversationUnarchivedNotificationSchema
>;
export type TaskConversationParticipantsAddedNotification = Static<
  typeof TaskConversationParticipantsAddedNotificationSchema
>;
export type TaskConversationParticipantsRemovedNotification = Static<
  typeof TaskConversationParticipantsRemovedNotificationSchema
>;

export const TaskConversationCreatedNotificationDefinition = defineNotification(
  {
    name: "task/conversation/created",
    params: TaskConversationCreatedNotificationSchema,
  },
);

export const TaskConversationArchivedNotificationDefinition =
  defineNotification({
    name: "task/conversation/archived",
    params: TaskConversationArchivedNotificationSchema,
  });

export const TaskConversationUnarchivedNotificationDefinition =
  defineNotification({
    name: "task/conversation/unarchived",
    params: TaskConversationUnarchivedNotificationSchema,
  });

export const TaskConversationParticipantsAddedNotificationDefinition =
  defineNotification({
    name: "task/conversation/participants/added",
    params: TaskConversationParticipantsAddedNotificationSchema,
  });

export const TaskConversationParticipantsRemovedNotificationDefinition =
  defineNotification({
    name: "task/conversation/participants/removed",
    params: TaskConversationParticipantsRemovedNotificationSchema,
  });
