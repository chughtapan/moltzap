import { Context, Effect } from "effect";
import type { ForbiddenError } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/task";
import { ConversationServiceTag } from "../layers.js";
import { notImplemented } from "./not-implemented.js";

/**
 * Tier 1 capability — caller is a member of `conversation_participants`
 * for `conversationId`.
 *
 * Value payload carries `(conversationId, callerAgentId)` so service
 * methods can `assertCapabilityMatchesConversation` against handler
 * input without re-querying.
 *
 * Replaces (Phase 3/4): 1 site in `conversation.service.ts`
 * (`requireParticipant` in the public read flow) + 2 in
 * `message.service.ts` (`sendInsertEffect`, the visible-message read in
 * `messages.list`).
 */
export interface ConversationParticipantAccessValue {
  readonly conversationId: ConversationId;
  readonly callerAgentId: AgentId;
}

export class ConversationParticipantAccess extends Context.Tag(
  "@moltzap/server/ConversationParticipantAccess",
)<ConversationParticipantAccess, ConversationParticipantAccessValue>() {}

/**
 * Architect-stub. Body shape:
 *   const conv = yield* ConversationServiceTag;
 *   yield* conv.requireParticipant(conversationId, caller);
 *   return { conversationId, callerAgentId: caller };
 */

/**
 * Error channel — propagates `ConversationService.requireParticipant`'s
 * `ForbiddenError` ("Not a participant in this conversation"). The
 * `SqlError` from the underlying `conversation_participants` lookup is
 * caught defectively by `catchSqlErrorAsDefect` inside the service
 * helper, so it does NOT appear in E.
 */
export const obtainConversationParticipantAccess = (
  _conversationId: ConversationId,
  _caller: AgentId,
): Effect.Effect<
  ConversationParticipantAccessValue,
  ForbiddenError,
  ConversationServiceTag
> => notImplemented("obtainConversationParticipantAccess") as never;
