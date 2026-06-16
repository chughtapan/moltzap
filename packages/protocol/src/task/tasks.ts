import { Schema } from "effect";
import { stringEnum, dateTimeStringSchema } from "#transport";
import { ListLimitSchema, listCursorSchema } from "#transport";
import { AgentId, AgentNotFoundError } from "#identity/agents";
import { ActiveAgent } from "#identity/requirements";
import { AgentPrincipal, AppPrincipal } from "#identity/principals";
import { ForbiddenError, InvalidParamsError } from "#transport";
import { defineRpc, defineNotification } from "#transport";
import { conversationSchema, ConversationFullError } from "#conversation";
import { AppId } from "#identity/apps";
import { ContactPolicyAllowsReach } from "#identity/contacts/requirements";
import { TaskId, TaskNotFoundError } from "./ids.js";

export { AppId, DEFAULT_APP_ID } from "#identity/apps";

// ═══════════════════════════════════════════════════════════════════
// SHARED — task value types + errors used by 2+ blocks in this file.
//
// `TaskSchema` is the task-row shape returned by `agent/task/list`,
// `app/task/update` close results, `agent/task/request`, and pushed by the
// `agent/task/created` / `agent/task/closed`
// notifications; `TaskParticipantSchema` is the membership row;
// `ConversationSchema` the conversation row that `agent/task/request` may return.
// The tagged errors are the task surface's shared failure channels.
//
// A task is the unit of admission: every conversation under a task draws its
// participant pool from `task_participants`, and the owning app is the
// gatekeeper for membership changes.
//
// Authority gates:
//
// | Method                              | Authority                                |
// |-------------------------------------|------------------------------------------|
// | agent/task/list                     | self only (own tasks)                    |
// | agent/task/request                  | active agent + contact-policy            |
// | agent/task/leave                    | self only                                |
// | app/task/update                     | owning app only                          |
//
// App authority: the app-callable task-admin RPCs head their `requires` with
// `AppPrincipal` and gate on `assertCallerAppOwnsTask` before any participant
// probe.
//
// Notification emission: each mutating op enqueues notifications AFTER the row
// mutation returns. Broadcast is best-effort: socket writes fork via
// `Effect.runFork` and do not roll back the DB write on delivery failure.
// ═══════════════════════════════════════════════════════════════════

const DateTimeString = dateTimeStringSchema();
const ConversationSchema = conversationSchema();

/**
 * Optional supplemental wire fields every domain tagged-error carries: an
 * overriding `message` and a free-form `data` payload, round-tripped by the
 * engine when it encodes/decodes the error against a method's error union.
 */
const errorPayloadFields = {
  message: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
} as const;

export class TaskClosedError extends Schema.TaggedError<TaskClosedError>()(
  "TaskClosed",
  errorPayloadFields,
) {
  static readonly message = "Task is closed";
}

/**
 * `agent/task/request` failed because the owning app rejected the
 * server-initiated `app/task/create` callback (or the fail-closed
 * envelope synthesized a reject on timeout / RPC error / decode
 * failure). The tag lets a requester distinguish "my task was
 * rejected by the moderator" — an expected, actionable outcome —
 * from an opaque internal error. The app's reason rides in the
 * `data` arm when present.
 */
export class TaskRejectedError extends Schema.TaggedError<TaskRejectedError>()(
  "TaskRejected",
  errorPayloadFields,
) {
  static readonly message = "Task request was rejected by the owning app";
}

export class HookBlockedError extends Schema.TaggedError<HookBlockedError>()(
  "HookBlocked",
  errorPayloadFields,
) {
  static readonly message = "Hook blocked the dispatch";
}

// Mirrors the `task_status` DB enum.
const TaskStatusEnum = stringEnum(["waiting", "active", "failed", "closed"]);

export type TaskStatus = Schema.Schema.Type<typeof TaskStatusEnum>;

const TaskSchema = Schema.Struct({
  id: TaskId,
  appId: Schema.String,
  initiatorAgentId: AgentId,
  status: TaskStatusEnum,
  startedAt: Schema.Union(DateTimeString, Schema.Null),
  endedAt: Schema.Union(DateTimeString, Schema.Null),
  createdAt: DateTimeString,
});

export type Task = Schema.Schema.Type<typeof TaskSchema>;

// `admittedAt = null` is reserved for a future "pending invitation"
// flow. Today the server auto-admits every invitee at TaskRequest, so
// the field is always non-null on the wire. The column is kept
// nullable + the `WHERE admitted_at IS NOT NULL` filters in read
// paths stay in place so the future flow drops in without
// re-engineering the gating.
const TaskParticipantSchema = Schema.Struct({
  taskId: TaskId,
  agentId: AgentId,
  admittedAt: Schema.Union(DateTimeString, Schema.Null),
});

export type TaskParticipant = Schema.Schema.Type<typeof TaskParticipantSchema>;

// ═══════════════════════════════════════════════════════════════════
// agent/task/list
// ═══════════════════════════════════════════════════════════════════

/**
 * List the caller's own tasks, cursor-paginated.
 *
 * - **Principal:** `AgentPrincipal` head.
 * @error InvalidParamsError when the `cursor` does not decode
 */
export const TaskList = defineRpc({
  name: "agent/task/list",
  params: Schema.Struct({
    limit: ListLimitSchema,
    cursor: Schema.optional(listCursorSchema()),
  }),
  result: Schema.Struct({
    tasks: Schema.Array(TaskSchema),
    nextCursor: Schema.optional(listCursorSchema()),
  }),
  requires: [AgentPrincipal],
  errors: [InvalidParamsError],
});

// ═══════════════════════════════════════════════════════════════════
// agent/task/request
// ═══════════════════════════════════════════════════════════════════

const InitialConversationSchema = Schema.Struct({
  name: Schema.optional(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)),
  ),
  participants: Schema.optional(Schema.Array(AgentId).pipe(Schema.minItems(1))),
});

export type InitialConversationInput = Schema.Schema.Type<
  typeof InitialConversationSchema
>;

/**
 * Open to any active agent. Returns `{ task, conversation }` where
 * `conversation` is `null` when `initialConversation` is omitted.
 *
 * Dedup is a client-side concern: clients that want "one DM per
 * participant set" semantics list their tasks and filter locally
 * before creating a new one.
 *
 * The agent-facing entry RPC is `agent/task/request`; the app-facing wire
 * callback `app/task/create` lives in this task domain. The server
 * forks `app/task/create` to the owning app after inserting the task in
 * `waiting`; the app verdict drives the lifecycle (accept → active +
 * `agent/task/created`; reject → failed + `agent/task/failed`). The
 * synchronous `{ task, conversation }`
 * result is returned after the verdict resolves (the handler awaits it).
 *
 * - **Principal:** `AgentPrincipal` head + `ActiveAgent` (active agent).
 * - **Requirements (run order):** `ContactPolicyAllowsReach` proves the caller may
 *   reach every `invitedAgentIds` target under the recipient's contact policy.
 * @error TaskRejectedError when the owning app rejects the task
 * @error AgentNotFoundError when an `initialConversation` participant agent is missing
 * @error ConversationFullError when the `initialConversation` exceeds capacity
 */
export const TaskRequest = defineRpc({
  name: "agent/task/request",
  params: Schema.Struct({
    appId: AppId,
    invitedAgentIds: Schema.Array(AgentId),
    initialConversation: Schema.optional(InitialConversationSchema),
  }),
  result: Schema.Struct({
    task: TaskSchema,
    conversation: Schema.Union(ConversationSchema, Schema.Null),
  }),
  requires: [AgentPrincipal, ActiveAgent, ContactPolicyAllowsReach],
  errors: [TaskRejectedError, AgentNotFoundError, ConversationFullError],
});

// ═══════════════════════════════════════════════════════════════════
// app/task/create (reverse callback)
//
// Agent-driven `agent/task/request` creates a task in `"waiting"` state and forks
// this wire callback to the registered app. The app responds with an
// accept/reject verdict; on accept the task transitions to `"active"`.
// ═══════════════════════════════════════════════════════════════════

const TaskCreateContextSchema = Schema.Struct({
  taskId: TaskId,
  initiatorAgentId: AgentId,
  invitedAgentIds: Schema.Array(AgentId),
  initialConversation: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      participants: Schema.optional(Schema.Array(AgentId)),
    }),
  ),
  receivedAt: Schema.optional(DateTimeString),
});

const TaskCreateVerdictSchema = Schema.Union(
  Schema.Struct({ decision: Schema.Literal("accept") }),
  Schema.Struct({
    decision: Schema.Literal("reject"),
    // Bound matches `TaskFailedNotificationDefinition.reason`.
    reason: Schema.optional(
      Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
    ),
  }),
);

/**
 * Server → app round-trip asking whether the app accepts a newly requested
 * task.
 *
 * - **Principal:** none — a server→client reverse callback.
 * @error ForbiddenError when the app rejects; the server treats the verdict as a fail-closed reject
 */
export const TaskCreate = defineRpc({
  name: "app/task/create",
  params: TaskCreateContextSchema,
  result: Schema.Struct({ verdict: TaskCreateVerdictSchema }),
  requires: [],
  errors: [ForbiddenError],
});

// ═══════════════════════════════════════════════════════════════════
// agent/task/leave
// ═══════════════════════════════════════════════════════════════════

/**
 * Self-only: caller removes themselves from `task_participants` AND
 * every `conversation_participants` row under the task.
 *
 * Notification emission for each conversation the caller leaves uses
 * `ConversationParticipantsRemovedNotificationDefinition` with
 * `reason: "task_leave"`. If removal empties `task_participants` the task
 * transitions to `status = 'closed'` and `TaskClosedNotificationDefinition`
 * fires alongside in the same transaction.
 *
 * - **Principal:** `AgentPrincipal` head + `ActiveAgent` (active agent).
 * @error TaskNotFoundError when the task does not exist or the caller is not in it
 */
export const TaskLeave = defineRpc({
  name: "agent/task/leave",
  params: Schema.Struct({ taskId: TaskId }),
  result: Schema.Struct({}),
  requires: [AgentPrincipal, ActiveAgent],
  errors: [TaskNotFoundError],
});

const TaskUpdateParamsSchema = Schema.Union(
  Schema.Struct({
    action: Schema.Literal("close"),
    taskId: TaskId,
  }),
  Schema.Struct({
    action: Schema.Literal("add-participant"),
    taskId: TaskId,
    agentId: AgentId,
  }),
  Schema.Struct({
    action: Schema.Literal("remove-participant"),
    taskId: TaskId,
    agentId: AgentId,
  }),
);

const TaskUpdateResultSchema = Schema.Union(
  Schema.Struct({
    action: Schema.Literal("closed"),
    task: TaskSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("participant-added"),
    participant: TaskParticipantSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("participant-removed"),
  }),
);

export type TaskUpdateParams = Schema.Schema.Type<
  typeof TaskUpdateParamsSchema
>;
export type TaskUpdateResult = Schema.Schema.Type<
  typeof TaskUpdateResultSchema
>;

/**
 * App-only task mutation surface. `app/task/update` owns task close,
 * participant admit, and participant remove semantics.
 *
 * - **Principal:** `AppPrincipal` head. The app-arm handler runs
 *   `assertCallerAppOwnsTask` before dispatching the selected action.
 * @error ForbiddenError when the caller does not own the task
 * @error TaskNotFoundError when the task does not exist
 */
export const TaskUpdate = defineRpc({
  name: "app/task/update",
  params: TaskUpdateParamsSchema,
  result: TaskUpdateResultSchema,
  requires: [AppPrincipal],
  errors: [ForbiddenError, TaskNotFoundError],
});

// ═══════════════════════════════════════════════════════════════════
// task/* lifecycle notifications
// ═══════════════════════════════════════════════════════════════════

const TaskFailedNotificationSchema = Schema.Struct({
  taskId: TaskId,
  // Free-form one-liner. The app/task/create callback verdict's
  // `reject.reason`, the synthesized `"app_unreachable"` / `"timeout"`
  // strings from the fail-closed envelope, and any future caller-supplied
  // failure reason all flow through here.
  reason: Schema.optional(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  ),
});

const TaskCreatedNotificationSchema = Schema.Struct({ task: TaskSchema });

const TaskClosedNotificationSchema = Schema.Struct({ task: TaskSchema });

/**
 * Pushed when a task fails before becoming ready.
 * @triggeredBy app/task/create
 */
export const TaskFailedNotificationDefinition = defineNotification({
  name: "agent/task/failed",
  params: TaskFailedNotificationSchema,
});

/**
 * Pushed to the task initiator + invited participants after the app accepts via
 * the `app/task/create` wire callback and the task transitions from `waiting`
 * to `active`. Carries the full Task row (matching `agent/task/closed`'s shape) so
 * subscribers don't need a second read to discover the post-transition state.
 */
export const TaskCreatedNotificationDefinition = defineNotification({
  name: "agent/task/created",
  params: TaskCreatedNotificationSchema,
});

/**
 * Pushed when a task closes.
 * @triggeredBy app/task/update
 */
export const TaskClosedNotificationDefinition = defineNotification({
  name: "agent/task/closed",
  params: TaskClosedNotificationSchema,
});
