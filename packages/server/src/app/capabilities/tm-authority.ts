import { Effect } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import {
  TmAuthority,
  type TmAuthorityValue,
  type TaskId,
} from "@moltzap/protocol/task";
import { TaskServiceTag } from "../layers.js";
import type { TaskServiceError } from "../../task/services/task.service.js";

export { TmAuthority, type TmAuthorityValue };

/**
 * Smart constructor: wraps today's runtime check exactly once per
 * request. Body delegates to `TaskService.loadTaskAsTmAuthority`, which
 * still performs the same SQL lookup + status branch + endpoint
 * equality check it did pre-Spec-E.
 *
 * Error channel propagates `TaskService.loadTaskAsTmAuthority`'s full
 * public error union (`TaskServiceError`) verbatim — practically
 * `ForbiddenError` (not-the-TM, task-closed/failed) and `NotFoundError`
 * (task-does-not-exist); `SqlError` is caught defectively by
 * `fetchTask` so it does NOT appear in E. The union is carried as
 * `TaskServiceError` so impl-staff cannot accidentally over-narrow
 * when the underlying helper widens.
 */
export const obtainTmAuthority = (
  taskId: TaskId,
  caller: AgentId,
): Effect.Effect<TmAuthorityValue, TaskServiceError, TaskServiceTag> =>
  Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const task = yield* taskService.loadTaskAsTmAuthority(taskId, caller);
    return { task, callerAgentId: caller };
  }).pipe(Effect.withSpan("obtainTmAuthority"));
