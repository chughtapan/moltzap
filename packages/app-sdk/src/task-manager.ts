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
 * round-2 goal 2). Each sends a `tmKind` discriminator on the `task/create`
 * RPC so the server mints the right default-DM / default-group / app endpoint.
 *
 *   - `createDmTask(A, B)`       → binds to the platform default DM TM.
 *                                   Before calling `task/create` the server
 *                                   consults `DefaultDmTaskManager.lookupExistingDm`
 *                                   and returns the existing task id on hit
 *                                   (best-effort; see spec #137 Q7).
 *   - `createGroupTask([...])`   → binds to the platform default group
 *                                   passthrough TM.
 *   - `createAppTask(appId, ...)`→ binds to the app's TM registered via
 *                                   `registerTaskManager`.
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
