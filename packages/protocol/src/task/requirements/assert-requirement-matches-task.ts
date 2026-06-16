import { Effect } from "effect";
import { ForbiddenError } from "#transport";
import type { TaskId } from "../ids.js";
import type { Task } from "../tasks.js";
import type { AppId } from "#identity/apps";
import type { TaskReadAccessValue } from "./task-read-access.js";

/**
 * Runtime equality check: the requirement's carried `taskId` matches
 * the caller-passed `expectedTaskId`. One-line guard at the start of
 * every service method that consumes a requirement + a separate `taskId`
 * handler-input — catches the "handler obtained requirement for task A
 * but passed task B" bug at a token cost (one comparison).
 *
 * Variants below mirror each requirement's carried-ID shape.
 */

const ERR_REQUIREMENT_TASK_MISMATCH = "requirement/task mismatch";
const assertTaskIdMatches = (
  requirementTaskId: TaskId,
  expectedTaskId: TaskId,
): Effect.Effect<void, ForbiddenError> => {
  if (requirementTaskId !== expectedTaskId) {
    return Effect.fail(
      new ForbiddenError({ message: ERR_REQUIREMENT_TASK_MISMATCH }),
    );
  }
  return Effect.void;
};

/**
 * Verifies `requirement.task.id === expectedTaskId` for `TaskReadAccess`. A
 * separate overload keeps the type narrowed at the call site.
 */
export const assertTaskReadAccessMatchesTask = (
  requirement: TaskReadAccessValue,
  expectedTaskId: TaskId,
): Effect.Effect<void, ForbiddenError> =>
  assertTaskIdMatches(requirement.task.id, expectedTaskId);

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
