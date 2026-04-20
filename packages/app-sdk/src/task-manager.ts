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
