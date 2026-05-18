import { Context, Effect } from "effect";
import type { TaskStatus } from "@moltzap/protocol";
import type { TaskId } from "@moltzap/protocol/task";
import { notImplemented } from "./not-implemented.js";

/**
 * Tier 4 refine-shape capability — task status accepts messages
 * (NOT `closed` / `failed`).
 *
 * Refine-shape: takes a `SendConversationRow` already fetched by
 * `MessageService.readSendConversation` and validates the task_status
 * column inline. No DB call. Replaces (Phase 4):
 * `MessageService.requireTaskCanReceiveMessage` for the non-bypass
 * branch.
 *
 * The TM-bypass branch is NOT a `TaskActive` proof — it's modeled in
 * the composite `MessageSendPermission.forTmBypass` constructor instead
 * (Architect Decision A; see `message-send-permission.ts`).
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
 * Architect-stub refine constructor. Body shape:
 *   if (status === "closed" || status === "failed") return yield*
 *     Effect.fail(new TaskClosedError(...));
 *   return { taskId, status };
 */
export const refineTaskActive = (
  _taskId: TaskId,
  _status: TaskStatus,
): Effect.Effect<TaskActiveValue, never> =>
  notImplemented("refineTaskActive") as never;
