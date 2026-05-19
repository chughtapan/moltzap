import { Context, Effect } from "effect";
import type { Task } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { TaskId } from "@moltzap/protocol/task";
import { TaskServiceTag } from "../layers.js";
import type { TaskServiceError } from "../../task/services/task.service.js";

/**
 * Tier 1 capability — caller has read access to `task` (initiator OR
 * admitted `task_participant`).
 *
 * Value payload carries the `task` row already fetched by today's
 * `TaskService.loadTaskWithReadAccess` check; consumers reuse the payload.
 *
 * Replaces (Phase 2): every `yield* this.loadTaskWithReadAccess(id, caller)`
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
 * Smart constructor. Delegates to `TaskService.loadTaskWithReadAccess` so the
 * SQL lookup + initiator-or-participant branch is unchanged from
 * pre-Spec-E.
 *
 * Error channel propagates `TaskService.loadTaskWithReadAccess`'s public
 * failure modes verbatim: `ForbiddenError` for "caller is neither
 * initiator nor admitted participant"; `NotFoundError` for "task does
 * not exist".
 */
export const obtainTaskReadAccess = (
  taskId: TaskId,
  caller: AgentId,
): Effect.Effect<TaskReadAccessValue, TaskServiceError, TaskServiceTag> =>
  Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const task = yield* taskService.loadTaskWithReadAccess(taskId, caller);
    return { task, callerAgentId: caller };
  }).pipe(Effect.withSpan("obtainTaskReadAccess"));
