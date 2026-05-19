import { Context } from "effect";
import type { Task } from "../tasks.js";
import type { AgentId } from "../../identity/index.js";

/**
 * Tier 1 capability — caller has read access to `task` (initiator OR
 * admitted `task_participant`).
 *
 * Value payload carries the `task` row already fetched by today's
 * `TaskService.loadTaskWithReadAccess` check; consumers reuse the payload.
 *
 * Consumed by the `task.service.ts` public methods (`get`, `getMessages`,
 * `getMessagesSince`) via the R-channel; handlers wire the value with
 * `Effect.provideServiceEffect(TaskReadAccess, obtainTaskReadAccess(...))`.
 */
export interface TaskReadAccessValue {
  readonly task: Task;
  readonly callerAgentId: AgentId;
}

export class TaskReadAccess extends Context.Tag(
  "@moltzap/protocol/TaskReadAccess",
)<TaskReadAccess, TaskReadAccessValue>() {}
