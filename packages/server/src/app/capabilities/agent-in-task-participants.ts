import { Context, Effect } from "effect";
import type { ForbiddenError } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { TaskId } from "@moltzap/protocol/task";
import { TaskServiceTag } from "../layers.js";

/**
 * Tier 2 capability — `agentId` is in `task_participants` for `taskId`.
 * Used by `TaskConversationAddParticipant` (D1's new handler) to prove
 * the agent being added to a conversation already participates in the
 * parent task — today's inline `task_participants` query becomes the
 * capability obtain.
 *
 * Phase 1 ships the tag + obtain helper; D1's
 * `TaskConversationAddParticipant` handler consumes it from day one
 * (E ships before D1 lands).
 */
export interface AgentInTaskParticipantsValue {
  readonly taskId: TaskId;
  readonly agentId: AgentId;
}

export class AgentInTaskParticipants extends Context.Tag(
  "@moltzap/server/AgentInTaskParticipants",
)<AgentInTaskParticipants, AgentInTaskParticipantsValue>() {}

/**
 * Smart constructor. Delegates to
 * `TaskService.requireAgentInTaskParticipants` (NEW in Phase 1 per
 * Decision B / Option A) so the underlying `task_participants` query
 * stays in the service layer.
 *
 * Error channel — fails with `ForbiddenError` when the agent is not in
 * `task_participants` for the given task. `SqlError` is caught
 * defectively at the service-helper boundary.
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
    yield* taskService.requireAgentInTaskParticipants(taskId, agentId);
    return { taskId, agentId };
  }).pipe(Effect.withSpan("obtainAgentInTaskParticipants"));
