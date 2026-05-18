import { Context, Effect } from "effect";
import type { ForbiddenError, NotFoundError, Task } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { TaskId } from "@moltzap/protocol/task";
import { TaskServiceTag } from "../layers.js";
import { notImplemented } from "./not-implemented.js";

/**
 * Tier 1 capability — caller is the registered task manager for `task.id`.
 *
 * Value payload carries the `task` row already fetched by today's
 * `TaskService.requireTmAuthority` check; consumers reuse the payload
 * instead of re-querying. `callerAgentId` lets refine-shape capabilities
 * (e.g. `MessageSendPermission.forTmBypass`) verify the same agent
 * authored the bypass decision.
 *
 * Replaces (Phase 2): every `yield* this.requireTmAuthority(id, caller)`
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
 * Architect-stub. Phase 1 implement-staff (#601) supplies the body.
 *
 * Body shape (per spec #601 §Migration architecture):
 *   const taskService = yield* TaskServiceTag;
 *   const task = yield* taskService.requireTmAuthority(taskId, caller);
 *   return { task, callerAgentId: caller };
 */

/**
 * Error channel — propagates `TaskService.requireTmAuthority`'s public
 * failure modes verbatim. `ForbiddenError` covers the "not the TM" and
 * "task closed/failed" branches; `NotFoundError` covers "task does not
 * exist". `SqlError` is caught defectively by the underlying service
 * helper (see `task.service.ts → fetchTask`), so it does NOT appear in
 * E. Phase 2 service-method consumers MAY widen E further when they
 * pipe additional effects through the obtain helper.
 */
export const obtainTmAuthority = (
  _taskId: TaskId,
  _caller: AgentId,
): Effect.Effect<
  TmAuthorityValue,
  ForbiddenError | NotFoundError,
  TaskServiceTag
> => notImplemented("obtainTmAuthority") as never;
