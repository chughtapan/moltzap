import { Effect } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import {
  TaskReadAccess,
  type TaskReadAccessValue,
  type TaskId,
} from "@moltzap/protocol/task";
import { TaskServiceTag } from "../layers.js";
import type { TaskServiceError } from "../../task/services/task.service.js";

export { TaskReadAccess, type TaskReadAccessValue };

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
