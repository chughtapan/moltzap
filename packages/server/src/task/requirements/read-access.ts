import { Effect } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import {
  TaskNotFoundError,
  type TaskId,
  type TaskReadAccessValue,
} from "@moltzap/protocol/task";
import { TaskServiceTag } from "../layer.js";

export interface TaskAndAgent {
  readonly taskId: TaskId;
  readonly callerAgentId: AgentId;
}

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
