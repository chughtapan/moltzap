import { Context, Effect } from "effect";
import type { Task } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { TaskId } from "@moltzap/protocol/task";
import { TaskServiceTag } from "../layers.js";
import { notImplemented } from "./not-implemented.js";

/**
 * Tier 1 capability — caller has read access to `task` (initiator OR
 * admitted `task_participant`).
 *
 * Value payload carries the `task` row already fetched by today's
 * `TaskService.requireReadAccess` check; consumers reuse the payload.
 *
 * Replaces (Phase 2): every `yield* this.requireReadAccess(id, caller)`
 * site in `task.service.ts` (`get`, `getMessages`, `getMessagesSince`).
 */
export interface TaskReadAccessValue {
  readonly task: Task;
  readonly callerAgentId: AgentId;
}

export class TaskReadAccess extends Context.Tag(
  "@moltzap/server/TaskReadAccess",
)<TaskReadAccess, TaskReadAccessValue>() {}

/**
 * Architect-stub. Body shape:
 *   const taskService = yield* TaskServiceTag;
 *   const task = yield* taskService.requireReadAccess(taskId, caller);
 *   return { task, callerAgentId: caller };
 */
export const obtainTaskReadAccess = (
  _taskId: TaskId,
  _caller: AgentId,
): Effect.Effect<TaskReadAccessValue, never, TaskServiceTag> =>
  notImplemented("obtainTaskReadAccess") as never;
