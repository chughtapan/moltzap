import { Context } from "effect";
import type { AgentId } from "../../identity/index.js";
import type { ConversationId } from "../conversations.js";

/**
 * Tier 1 capability — caller is a member of `conversation_participants`
 * for `conversationId`.
 *
 * Value payload carries `(conversationId, callerAgentId)` so service
 * methods can `assertCapabilityMatchesConversation` against handler
 * input without re-querying.
 */
export interface ConversationParticipantAccessValue {
  readonly conversationId: ConversationId;
  readonly callerAgentId: AgentId;
}

export class ConversationParticipantAccess extends Context.Tag(
  "@moltzap/protocol/ConversationParticipantAccess",
)<ConversationParticipantAccess, ConversationParticipantAccessValue>() {}
