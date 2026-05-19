import { Context, Effect } from "effect";
import type { Task } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { TaskId } from "@moltzap/protocol/task";
import { TaskServiceTag } from "../layers.js";
import type { TaskServiceError } from "../../task/services/task.service.js";

/**
 * Tier 1 capability — caller is the registered task manager for `task.id`.
 *
 * Value payload carries the `task` row already fetched by today's
 * `TaskService.loadTaskAsTmAuthority` check; consumers reuse the payload
 * instead of re-querying. `callerAgentId` lets refine-shape capabilities
 * (e.g. `MessageSendPermission.forTmBypass`) verify the same agent
 * authored the bypass decision.
 *
 * Replaces (Phase 2): every `yield* this.loadTaskAsTmAuthority(id, caller)`
 * site in `task.service.ts` (`closeWithLifecycle`, `addParticipant`,
 * `removeParticipant`, `createConversation`, `closeConversation`,
 * `storeMessage`).
 */
export interface TmAuthorityValue {
  readonly task: Task;
  readonly callerAgentId: AgentId;
}

export class TmAuthority extends Context.Tag("@moltzap/server/TmAuthority")<
  TmAuthority,
  TmAuthorityValue
>() {}

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
