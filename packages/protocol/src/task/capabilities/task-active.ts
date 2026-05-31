import { Context, Effect } from "effect";
import { TaskClosedError, type TaskStatus, type TaskId } from "../tasks.js";

/**
 * Tier 4 refine-shape capability — task status accepts messages
 * (NOT `closed` / `failed`).
 *
 * Refine-shape: takes a `SendConversationRow` already fetched by
 * `MessageService.readSendConversation` and validates the `task_status`
 * column inline. No DB call. Consumed by `obtainMessageSendPermission`
 * when populating the composite `MessageSendPermission` value.
 *
 * ## Staleness window
 *
 * `TaskActive` is a liveness proof — `tasks.status` can transition
 * `active → closed` between obtain and use. The refine helper is safe
 * to call inside the same transaction that reads the task row;
 * cross-transaction reuse is a defect (re-obtain by re-reading the
 * column).
 */
export interface TaskActiveValue {
  readonly taskId: TaskId;
  readonly status: TaskStatus;
}

export class TaskActive extends Context.Tag("@moltzap/protocol/TaskActive")<
  TaskActive,
  TaskActiveValue
>() {}

/**
 * Refine constructor. Fails with `TaskClosedError` when status is
 * `closed` / `failed`. Consumed by `obtainMessageSendPermission`.
 */
export const refineTaskActive = (
  taskId: TaskId,
  status: TaskStatus,
): Effect.Effect<TaskActiveValue, TaskClosedError> => {
  if (status === "closed" || status === "failed") {
    return Effect.fail(
      new TaskClosedError({
        message: `Task is ${status}`,
        data: { reason: "TaskClosed", taskId, status },
      }),
    );
  }
  return Effect.succeed({ taskId, status });
};
