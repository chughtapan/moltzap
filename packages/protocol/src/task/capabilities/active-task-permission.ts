import { Context } from "effect";
import { TaskClosedError, type TaskStatus, type TaskId } from "../tasks.js";

/**
 * Permission: sending is allowed only while the task is active (status is NOT
 * `closed` / `failed`). The server `obtain` reads the `taskStatus` column off
 * the shared `ConversationSendAccess` row — no DB call of its own — and fails
 * `TaskClosed` when the task is not active.
 *
 * ## Staleness window
 *
 * `tasks.status` can transition `active → closed` between read and use, so the
 * permission holds only inside the same transaction that read the row;
 * cross-transaction reuse is a defect (re-read the column to re-validate).
 */
export interface ActiveTaskPermissionValue {
  readonly taskId: TaskId;
  readonly status: TaskStatus;
}

export class ActiveTaskPermission extends Context.Tag(
  "@moltzap/protocol/ActiveTaskPermission",
)<ActiveTaskPermission, ActiveTaskPermissionValue>() {
  static get errors() {
    return [TaskClosedError] as const;
  }
}
