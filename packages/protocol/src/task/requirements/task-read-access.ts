import { Schema } from "effect";
import { RpcMiddleware } from "@effect/rpc";
import type { Task } from "../tasks.js";
import { TaskNotFoundError } from "../ids.js";
import type { AgentId } from "../../identity/index.js";

/**
 * Requirement: caller has read access to `task` (initiator OR
 * admitted `task_participant`).
 *
 * Value payload carries the `task` row already fetched by the
 * `TaskService.loadTaskWithReadAccess` check; consumers reuse the payload.
 *
 * The server middleware implementation resolves the value once and provides it
 * to handlers through the `@effect/rpc` middleware context.
 */
export interface TaskReadAccessValue {
  readonly task: Task;
  readonly callerAgentId: AgentId;
}

export class TaskReadAccess extends RpcMiddleware.Tag<TaskReadAccess>()(
  "@moltzap/protocol/TaskReadAccess",
  // Fails closed as not-found so the obtain does not leak task existence to a
  // caller without read access.
  { failure: Schema.Union(TaskNotFoundError) },
) {}
