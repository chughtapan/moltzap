import { Schema } from "effect";
import {
  stringEnum,
  dateTimeStringSchema,
  errorPayloadFields,
  listLimitSchema,
  listCursorSchema,
  ForbiddenError,
  InvalidParamsError,
} from "#transport";
import { agentId, AgentNotFoundError } from "#identity/agents";
import { ActiveAgent } from "#identity/requirements";
import { AgentPrincipal, AppPrincipal } from "#identity/principals";
import { defineRpc, defineNotification } from "#transport/descriptor";
import { conversationSchema, ConversationFullError } from "#conversation";
import { appId } from "#identity/apps";
import { ContactPolicyAllowsReach } from "#identity/contacts/requirements";
import { taskId, TaskNotFoundError } from "./ids.js";

/** Re-exports the public API from `#identity/apps`. */
export { type AppId, appId, DEFAULT_APP_ID } from "#identity/apps";

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

const dateTimeString = dateTimeStringSchema();
const conversationSchemaValue = conversationSchema();

/** Reports task closed failures. */
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

/** Reports hook blocked failures. */
export class HookBlockedError extends Schema.TaggedError<HookBlockedError>()(
  "HookBlocked",
  errorPayloadFields,
) {
  static readonly message = "Hook blocked the dispatch";
}

// Mirrors the `task_status` DB enum.
const taskStatusEnum = stringEnum(["waiting", "active", "failed", "closed"]);

/** Represents task status values. */
export type TaskStatus = Schema.Schema.Type<typeof taskStatusEnum>;

const taskSchema = Schema.Struct({
  id: taskId,
  appId: Schema.String,
  initiatorAgentId: agentId,
  status: taskStatusEnum,
  startedAt: Schema.Union(dateTimeString, Schema.Null),
  endedAt: Schema.Union(dateTimeString, Schema.Null),
  createdAt: dateTimeString,
});

/** Represents task values. */
export type Task = Schema.Schema.Type<typeof taskSchema>;

// `admittedAt = null` is reserved for a future "pending invitation"
// flow. Today the server auto-admits every invitee at TaskRequest, so
// the field is always non-null on the wire. The column is kept
// nullable + the `WHERE admitted_at IS NOT NULL` filters in read
// paths stay in place so the future flow drops in without
// re-engineering the gating.
const taskParticipantSchema = Schema.Struct({
  taskId: taskId,
  agentId: agentId,
  admittedAt: Schema.Union(dateTimeString, Schema.Null),
});

/** Represents task participant values. */
export type TaskParticipant = Schema.Schema.Type<typeof taskParticipantSchema>;

// ═══════════════════════════════════════════════════════════════════
// agent/task/list
// ═══════════════════════════════════════════════════════════════════

/**
 * List the caller's own tasks, cursor-paginated.
 *
 * - **Principal:** `AgentPrincipal` head.
 * @error InvalidParamsError when the `cursor` does not decode
 */
export const taskList = defineRpc({
  name: "agent/task/list",
  params: Schema.Struct({
    limit: listLimitSchema,
    cursor: Schema.optional(listCursorSchema()),
  }),
  result: Schema.Struct({
    tasks: Schema.Array(taskSchema),
    nextCursor: Schema.optional(listCursorSchema()),
  }),
  requires: [AgentPrincipal],
  errors: [InvalidParamsError],
});

// ═══════════════════════════════════════════════════════════════════
// agent/task/request
// ═══════════════════════════════════════════════════════════════════

const initialConversationSchema = Schema.Struct({
  name: Schema.optional(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)),
  ),
  participants: Schema.optional(Schema.Array(agentId).pipe(Schema.minItems(1))),
});

/** Represents initial conversation input values. */
export type InitialConversationInput = Schema.Schema.Type<
  typeof initialConversationSchema
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
 *   reach every invited agent and initial-conversation participant under the
 *   recipient's contact policy.
 * @error TaskRejectedError when the owning app rejects the task
 * @error AgentNotFoundError when an invited or initial-conversation participant is missing
 * @error ConversationFullError when the `initialConversation` exceeds capacity
 */
export const taskRequest = defineRpc({
  name: "agent/task/request",
  params: Schema.Struct({
    appId: appId,
    invitedAgentIds: Schema.Array(agentId),
    initialConversation: Schema.optional(initialConversationSchema),
  }),
  result: Schema.Struct({
    task: taskSchema,
    conversation: Schema.Union(conversationSchemaValue, Schema.Null),
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

const taskCreateContextSchema = Schema.Struct({
  taskId: taskId,
  initiatorAgentId: agentId,
  invitedAgentIds: Schema.Array(agentId),
  initialConversation: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      participants: Schema.optional(Schema.Array(agentId)),
    }),
  ),
  receivedAt: Schema.optional(dateTimeString),
});

const taskCreateVerdictSchema = Schema.Union(
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
export const taskCreate = defineRpc({
  name: "app/task/create",
  params: taskCreateContextSchema,
  result: Schema.Struct({ verdict: taskCreateVerdictSchema }),
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
export const taskLeave = defineRpc({
  name: "agent/task/leave",
  params: Schema.Struct({ taskId: taskId }),
  result: Schema.Struct({}),
  requires: [AgentPrincipal, ActiveAgent],
  errors: [TaskNotFoundError],
});

const taskUpdateParamsSchema = Schema.Union(
  Schema.Struct({
    action: Schema.Literal("close"),
    taskId: taskId,
  }),
  Schema.Struct({
    action: Schema.Literal("add-participant"),
    taskId: taskId,
    agentId: agentId,
  }),
  Schema.Struct({
    action: Schema.Literal("remove-participant"),
    taskId: taskId,
    agentId: agentId,
  }),
);

const taskUpdateResultSchema = Schema.Union(
  Schema.Struct({
    action: Schema.Literal("closed"),
    task: taskSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("participant-added"),
    participant: taskParticipantSchema,
  }),
  Schema.Struct({
    action: Schema.Literal("participant-removed"),
  }),
);

/** Represents task update params values. */
export type TaskUpdateParams = Schema.Schema.Type<
  typeof taskUpdateParamsSchema
>;
/** Represents the result of task update. */
export type TaskUpdateResult = Schema.Schema.Type<
  typeof taskUpdateResultSchema
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
export const taskUpdate = defineRpc({
  name: "app/task/update",
  params: taskUpdateParamsSchema,
  result: taskUpdateResultSchema,
  requires: [AppPrincipal],
  errors: [ForbiddenError, TaskNotFoundError],
});

// ═══════════════════════════════════════════════════════════════════
// task/* lifecycle notifications
// ═══════════════════════════════════════════════════════════════════

const taskFailedNotificationSchema = Schema.Struct({
  taskId: taskId,
  // Free-form one-liner. The app/task/create callback verdict's
  // `reject.reason`, the synthesized `"app_unreachable"` / `"timeout"`
  // strings from the fail-closed envelope, and any future caller-supplied
  // failure reason all flow through here.
  reason: Schema.optional(
    Schema.String.pipe(Schema.minLength(1), Schema.maxLength(256)),
  ),
});

const taskCreatedNotificationSchema = Schema.Struct({ task: taskSchema });

const taskClosedNotificationSchema = Schema.Struct({ task: taskSchema });

/**
 * Pushed when a task fails before becoming ready.
 * @triggeredBy app/task/create
 */
export const taskFailedNotificationDefinition = defineNotification({
  name: "agent/task/failed",
  params: taskFailedNotificationSchema,
});

/**
 * Pushed to the task initiator + invited participants after the app accepts via
 * the `app/task/create` wire callback and the task transitions from `waiting`
 * to `active`. Carries the full Task row (matching `agent/task/closed`'s shape) so
 * subscribers don't need a second read to discover the post-transition state.
 */
export const taskCreatedNotificationDefinition = defineNotification({
  name: "agent/task/created",
  params: taskCreatedNotificationSchema,
});

/**
 * Pushed when a task closes.
 * @triggeredBy app/task/update
 */
export const taskClosedNotificationDefinition = defineNotification({
  name: "agent/task/closed",
  params: taskClosedNotificationSchema,
});

/** Task RPC catalog callable by agent clients. */
export const agentCallableTaskRpcMethods = [
  taskRequest,
  taskList,
  taskLeave,
] as const;

/** Task RPC catalog callable by app clients. */
export const appCallableTaskRpcMethods = [taskUpdate] as const;

/** Task callback catalog served by app clients for server-initiated calls. */
export const taskCallbackMethods = [taskCreate] as const;

/** Task notification catalog emitted by the server. */
export const taskNotifications = [
  taskClosedNotificationDefinition,
  taskCreatedNotificationDefinition,
  taskFailedNotificationDefinition,
] as const;
