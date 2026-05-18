import { Context, Effect } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import type { TaskId } from "@moltzap/protocol/task";
import { TaskServiceTag } from "../layers.js";
import { notImplemented } from "./not-implemented.js";

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
 * Architect-stub. Body shape (Phase 1 implements directly via TaskService
 * because the today's check is inline SQL, not a `requireX` helper):
 *
 *   const taskService = yield* TaskServiceTag;
 *   yield* taskService.requireAgentInTaskParticipants(taskId, agentId);
 *   return { taskId, agentId };
 *
 * The `requireAgentInTaskParticipants` helper is NEW in Phase 1 — added
 * to `task.service.ts` as an `@internal` exported method per Decision B
 * (Option A), wrapping the same `task_participants` query D1's handler
 * would otherwise do inline.
 */
export const obtainAgentInTaskParticipants = (
  _taskId: TaskId,
  _agentId: AgentId,
): Effect.Effect<AgentInTaskParticipantsValue, never, TaskServiceTag> =>
  notImplemented("obtainAgentInTaskParticipants") as never;
