import { Context, Effect } from "effect";
import { TaskClosedError, type TaskStatus } from "@moltzap/protocol";
import type { TaskId } from "@moltzap/protocol/task";

/**
 * Tier 4 refine-shape capability — task status accepts messages
 * (NOT `closed` / `failed`).
 *
 * Refine-shape: takes a `SendConversationRow` already fetched by
 * `MessageService.readSendConversation` and validates the `task_status`
 * column inline. No DB call. Replaces (Phase 4):
 * `MessageService.requireTaskCanReceiveMessage` for the non-bypass
 * branch.
 *
 * The TM-bypass branch is NOT a `TaskActive` proof — it's modeled in
 * the composite `MessageSendPermission.forTmBypass` constructor instead
 * (Architect Decision A; see `message-send-permission.ts`).
 *
 * ## Staleness window
 *
 * `TaskActive` is a liveness proof — `tasks.status` can transition
 * `active → closed` between obtain and use. The refine helper is safe
 * to call inside the same transaction that reads the task row;
 * cross-transaction reuse is a defect (re-obtain by re-reading the
 * column). Spec #601 §Open question Q1 documents the convention; this
 * file mirrors it.
 */
export interface TaskActiveValue {
  readonly taskId: TaskId;
  readonly status: TaskStatus;
}

export class TaskActive extends Context.Tag("@moltzap/server/TaskActive")<
  TaskActive,
  TaskActiveValue
>() {}

/**
 * Refine constructor. Inlines today's status check from
 * `MessageService.requireTaskCanReceiveMessage` (non-bypass branch).
 * Fails with `TaskClosedError` when status is `closed` / `failed`.
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
