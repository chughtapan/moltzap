import { Effect } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import type { TaskId, TaskReadAccessValue } from "@moltzap/protocol/task";
import { TaskServiceTag } from "../layer.js";

export interface TaskAndAgent {
  readonly taskId: TaskId;
  readonly callerAgentId: AgentId;
}

export const obtainTaskReadAccess = (
  input: TaskAndAgent,
): Effect.Effect<TaskReadAccessValue, unknown, TaskServiceTag> =>
  Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    const task = yield* taskService.loadTaskWithReadAccess(
      input.taskId,
      input.callerAgentId,
    );
    return { task, callerAgentId: input.callerAgentId };
  }).pipe(Effect.withSpan("obtainTaskReadAccess"));
