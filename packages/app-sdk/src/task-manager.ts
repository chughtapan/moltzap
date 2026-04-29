import { Data, Effect } from "effect";
import type {
  AgentId,
  AppId,
  ConversationId,
  TaskId,
  TaskManagerAction,
  TaskMessagePayload,
} from "@moltzap/protocol/task";

export class TaskManagerHandlerTimeout extends Data.TaggedError(
  "TaskManagerHandlerTimeout",
)<{
  readonly taskId: TaskId;
  readonly elapsedMs: number;
}> {}

export class TaskManagerHandlerAuthorityError extends Data.TaggedError(
  "TaskManagerHandlerAuthorityError",
)<{
  readonly taskId: TaskId;
  readonly reason: "not_registered" | "wrong_app";
}> {}

export class TaskManagerHandlerRejected extends Data.TaggedError(
  "TaskManagerHandlerRejected",
)<{
  readonly taskId: TaskId;
  readonly reason: string;
}> {}

export class TaskManagerHandlerUserThrow extends Data.TaggedError(
  "TaskManagerHandlerUserThrow",
)<{
  readonly taskId: TaskId;
  readonly cause: unknown;
}> {}

export type TaskManagerError =
  | TaskManagerHandlerTimeout
  | TaskManagerHandlerAuthorityError
  | TaskManagerHandlerRejected
  | TaskManagerHandlerUserThrow;

export interface TaskManagerContext {
  readonly taskId: TaskId;
  readonly appId: AppId;
  readonly initiatorAgentId: AgentId;
  readonly participantIds: readonly AgentId[];
  readonly conversationIds: readonly ConversationId[];
}

export type TaskManagerHandler = (
  ctx: TaskManagerContext,
  msg: TaskMessagePayload,
) => Effect.Effect<TaskManagerAction, TaskManagerError, never>;

export class TaskManagerRegistrationError extends Data.TaggedError(
  "TaskManagerRegistrationError",
)<{
  readonly appId: AppId;
  readonly reason: "already_registered" | "transport_failed";
}> {}

export interface TaskManagerRegistration {
  readonly unregister: () => Effect.Effect<void, never, never>;
}

export interface RegisterTaskManager {
  (
    handler: TaskManagerHandler,
  ): Effect.Effect<TaskManagerRegistration, TaskManagerRegistrationError, never>;
}

export const registerTaskManager: RegisterTaskManager = (_handler) => {
  throw new Error("not implemented");
};

/**
 * Task-creation error surfaced by the SDK helpers below. Wraps the slice B
 * `TaskService` errors that the `task/create` RPC returns over the wire
 * (serialized form), plus the DM-uniqueness lookup path's storage error.
 */
export class CreateTaskError extends Data.TaggedError("CreateTaskError")<{
  readonly reason:
    | "transport_failed"
    | "storage_failed"
    | "invalid_participants"
    | "authority_error";
  readonly detail: string;
}> {}

/**
 * SDK helpers that bind a task to the correct TM at creation time (spec #137
 * round-2 goal 2). Each is a thin wrapper around exactly one RPC call:
 * `task/create` with a `tmKind` discriminator. The server owns lookup, create,
 * and registration atomically inside that single RPC — the SDK never calls
 * `DefaultDmTaskManager.lookupExistingDm` or any other server-side helper
 * directly. Response carries the task id (new or pre-existing).
 *
 *   - `createDmTask(A, B)`       → `task/create { tmKind: "default-dm", participants: [A, B] }`.
 *                                   Server-side handler: (1) looks up existing DM for
 *                                   (A, B) via the default DM TM's internal
 *                                   lookup; (2) returns that task id if found;
 *                                   (3) else calls `TaskService.createTask` +
 *                                   `TaskManagerRegistry.register` in one
 *                                   transaction. No client-side cross-layer call.
 *   - `createGroupTask([...])`   → `task/create { tmKind: "default-group", participants: [...] }`.
 *   - `createAppTask(appId, ...)`→ `task/create { tmKind: "app", appId, participants: [...] }`.
 *                                   Server-side handler registers the calling
 *                                   app as the TM via its prior
 *                                   `registerTaskManager` handle.
 */
export const createDmTask = (
  _a: AgentId,
  _b: AgentId,
): Effect.Effect<TaskId, CreateTaskError, never> => {
  throw new Error("not implemented");
};

export const createGroupTask = (
  _participants: readonly AgentId[],
): Effect.Effect<TaskId, CreateTaskError, never> => {
  throw new Error("not implemented");
};

export const createAppTask = (
  _appId: AppId,
  _participants: readonly AgentId[],
): Effect.Effect<TaskId, CreateTaskError, never> => {
  throw new Error("not implemented");
};
