import { Context, Effect } from "effect";
import type { Task } from "@moltzap/protocol";
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
export const obtainTmAuthority = (
  _taskId: TaskId,
  _caller: AgentId,
): Effect.Effect<
  TmAuthorityValue,
  // Error channel resolves to TaskServiceError once
  // TaskService.requireTmAuthority's E is re-exported. Stub leaves it
  // as `never` to avoid importing the union into the stub branch.
  never,
  TaskServiceTag
> => notImplemented("obtainTmAuthority") as never;
