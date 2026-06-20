import { Effect } from "effect";
import { ForbiddenError } from "#transport";
import type { TaskId } from "../ids.js";
import type { Task } from "../tasks.js";
import type { AppId } from "#identity/apps";
import type { TaskReadAccessValue } from "./task-read-access.js";

/**
 * Verifies `requirement.task.id === expectedTaskId` for `TaskReadAccess`.
 * One-line guard at the start of every service method that consumes the
 * requirement plus a separate `taskId` handler-input — catches the "handler
 * obtained requirement for task A but passed task B" bug for one comparison.
 */
export const assertTaskReadAccessMatchesTask = (
  requirement: TaskReadAccessValue,
  expectedTaskId: TaskId,
): Effect.Effect<void, ForbiddenError> => {
  if (requirement.task.id !== expectedTaskId) {
    return Effect.fail(
      new ForbiddenError({ message: "requirement/task mismatch" }),
    );
  }
  return Effect.void;
};

const ERR_NOT_TASK_APP = "Caller is not the app that owns this task";

/**
 * App-principal ownership gate. App task and conversation mutation handlers
 * load the open task and call this before the service mutation.
 *
 * `task.appId` rides as a wire `string`; the brand boundary is the type
 * system, so the equality check compares the branded `appId` argument to
 * the row value directly. Fails with `ForbiddenError` (wire -32001) when
 * the app does not own the task.
 */
export const assertAppOwnsTask = (
  appId: AppId,
  task: Task,
): Effect.Effect<void, ForbiddenError> => {
  if (task.appId !== appId) {
    return Effect.fail(new ForbiddenError({ message: ERR_NOT_TASK_APP }));
  }
  return Effect.void;
};
