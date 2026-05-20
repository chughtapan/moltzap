import { Effect } from "effect";
import type { ForbiddenError } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import {
  ConversationParticipantAccess,
  type ConversationParticipantAccessValue,
  type ConversationId,
} from "@moltzap/protocol/task";
import { ConversationServiceTag } from "../layers.js";

export {
  ConversationParticipantAccess,
  type ConversationParticipantAccessValue,
};

/**
 * Smart constructor. Delegates to
 * `ConversationService.assertConversationParticipant` (already public on the
 * service class pre-Spec-E).
 *
 * Error channel propagates `ConversationService.assertConversationParticipant`'s
 * `ForbiddenError` ("Not a participant in this conversation"). The
 * `SqlError` from the underlying `conversation_participants` lookup is
 * caught defectively inside the service helper, so it does NOT appear
 * in E.
 */
export const obtainConversationParticipantAccess = (
  conversationId: ConversationId,
  caller: AgentId,
): Effect.Effect<
  ConversationParticipantAccessValue,
  ForbiddenError,
  ConversationServiceTag
> =>
  Effect.gen(function* () {
    const conversations = yield* ConversationServiceTag;
    yield* conversations.assertConversationParticipant(conversationId, caller);
    return { conversationId, callerAgentId: caller };
  }).pipe(Effect.withSpan("obtainConversationParticipantAccess"));
