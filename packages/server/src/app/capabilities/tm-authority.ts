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
 * equality check it did pre-Spec-E. `SqlError` is caught defectively
 * by `fetchTask`. The error channel is carried as the full
 * `TaskServiceError` union so impl-staff cannot accidentally
 * over-narrow when the underlying helper widens.
 * @failure ForbiddenError when the caller is not the TM, or the task is closed/failed
 * @failure NotFoundError when the task does not exist
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
