import { Effect } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import {
  TaskNotFoundError,
  type TaskId,
  type TaskReadAccessValue,
} from "@moltzap/protocol/task";
import { TaskServiceTag } from "../layer.js";

/** Describes task and agent. */
export interface TaskAndAgent {
  readonly taskId: TaskId;
  readonly callerAgentId: AgentId;
}

/**
 * Provides the obtain task read access runtime value.
 * @param input Input value to process.
 * @returns The obtain task read access result.
 */
export const obtainTaskReadAccess = (
  input: TaskAndAgent,
): Effect.Effect<TaskReadAccessValue, TaskNotFoundError, TaskServiceTag> =>
  Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const task = yield* taskService
      .loadTaskWithReadAccess(input.taskId, input.callerAgentId)
      .pipe(
        Effect.catchTag("Forbidden", () =>
          Effect.fail(
            new TaskNotFoundError({ message: TaskNotFoundError.message }),
          ),
        ),
      );
    return { task, callerAgentId: input.callerAgentId };
  }).pipe(Effect.withSpan("obtainTaskReadAccess"));
