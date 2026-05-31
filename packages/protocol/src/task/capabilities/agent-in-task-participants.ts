import { Context } from "effect";
import type { AgentId } from "../../identity/index.js";
import type { TaskId } from "../tasks.js";

/**
 * Tier 2 capability — `agentId` is in `task_participants` for `taskId`.
 * The `TaskConversationAddParticipant` handler requires it to prove the
 * agent being added to a conversation already participates in the
 * parent task.
 */
export interface AgentInTaskParticipantsValue {
  readonly taskId: TaskId;
  readonly agentId: AgentId;
}

export class AgentInTaskParticipants extends Context.Tag(
  "@moltzap/protocol/AgentInTaskParticipants",
)<AgentInTaskParticipants, AgentInTaskParticipantsValue>() {}
