import { Effect } from "effect";
import type { ForbiddenError } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import {
  AgentInTaskParticipants,
  type AgentInTaskParticipantsValue,
  type TaskId,
} from "@moltzap/protocol/task";
import { TaskServiceTag } from "../layers.js";

export { AgentInTaskParticipants, type AgentInTaskParticipantsValue };

/**
 * Smart constructor. Delegates to
 * `TaskService.assertAgentInTaskParticipants` (NEW in Phase 1 per
 * Decision B / Option A) so the underlying `task_participants` query
 * stays in the service layer.
 *
 * `SqlError` is caught defectively at the service-helper boundary.
 * @failure ForbiddenError when the agent is not in `task_participants` for the given task
 */
export const obtainAgentInTaskParticipants = (
  taskId: TaskId,
  agentId: AgentId,
): Effect.Effect<
  AgentInTaskParticipantsValue,
  ForbiddenError,
  TaskServiceTag
> =>
  Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    yield* taskService.assertAgentInTaskParticipants(taskId, agentId);
    return { taskId, agentId };
  }).pipe(Effect.withSpan("obtainAgentInTaskParticipants"));
