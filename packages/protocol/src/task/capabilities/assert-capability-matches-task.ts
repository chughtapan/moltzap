import { Effect } from "effect";
import { ForbiddenError } from "../../transport/wire-errors.js";
import type { TaskId, Task } from "../tasks.js";
import type { AppId } from "#identity/apps";
import type { ConversationId } from "../../conversation/types.js";
import type { ConversationInTaskValue } from "./conversation-in-task.js";
import type { TaskReadAccessValue } from "./task-read-access.js";

/**
 * Runtime equality check: the capability's carried `taskId` matches
 * the caller-passed `expectedTaskId`. One-line guard at the start of
 * every service method that consumes a capability + a separate `taskId`
 * handler-input — catches the "handler obtained capability for task A
 * but passed task B" bug at a token cost (one comparison).
 *
 * Variants below mirror each capability's carried-ID shape.
 */

const ERR_CAP_TASK_MISMATCH = "capability/task mismatch";
const ERR_CAP_CONV_MISMATCH = "capability/conversation mismatch";

const assertTaskIdMatches = (
  capTaskId: TaskId,
  expectedTaskId: TaskId,
): Effect.Effect<void, ForbiddenError> => {
  if (capTaskId !== expectedTaskId) {
    return Effect.fail(new ForbiddenError({ message: ERR_CAP_TASK_MISMATCH }));
  }
  return Effect.void;
};

/**
 * Verifies `cap.task.id === expectedTaskId` for `TaskReadAccess`. A
 * separate overload keeps the type narrowed at the call site.
 */
export const assertTaskReadAccessMatchesTask = (
  cap: TaskReadAccessValue,
  expectedTaskId: TaskId,
): Effect.Effect<void, ForbiddenError> =>
  assertTaskIdMatches(cap.task.id, expectedTaskId);

/**
 * Verifies the capability's carried `(taskId, conversationId)` pair
 * equals the expected pair. Fails with `ForbiddenError` on the first
 * mismatch; runs both comparisons in one Effect for handler-side
 * symmetry with `assertTaskReadAccessMatchesTask`.
 */
export const assertConversationInTaskMatches = (
  cap: ConversationInTaskValue,
  expectedTaskId: TaskId,
  expectedConversationId: ConversationId,
): Effect.Effect<void, ForbiddenError> => {
  if (cap.taskId !== expectedTaskId) {
    return Effect.fail(new ForbiddenError({ message: ERR_CAP_TASK_MISMATCH }));
  }
  if (cap.conversationId !== expectedConversationId) {
    return Effect.fail(new ForbiddenError({ message: ERR_CAP_CONV_MISMATCH }));
  }
  return Effect.void;
};

const ERR_NOT_TASK_APP =
  "Caller is not the registered task manager for this task";

/**
 * App-principal ownership gate. Asserts the calling app IS the app
 * bound to `task` — the app on whose behalf the task's TM acts. The 8
 * task-admin RPCs (`task/close`, `task/addParticipant`,
 * `task/removeParticipant`, `task/conversation/{create,archive,
 * unarchive,addParticipant,removeParticipant}`) load the open task in
 * their handler and call this asserter before the service mutation.
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
