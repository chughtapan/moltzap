import { Context, Effect } from "effect";
import {
  ConversationArchivedError,
  type ConversationId,
} from "../conversations.js";

/**
 * Tier 4 refine-shape capability — `conversation.archived_at IS NULL`.
 *
 * Refine-shape: takes the `archived_at` column read inline by the
 * caller. Folded into the composite `MessageSendPermission` value
 * for the MessagesSend path (every constructor verifies the
 * conversation is open).
 */
export interface ConversationNotArchivedValue {
  readonly conversationId: ConversationId;
}

export class ConversationNotArchived extends Context.Tag(
  "@moltzap/protocol/ConversationNotArchived",
)<ConversationNotArchived, ConversationNotArchivedValue>() {}

/**
 * Refine constructor. Fails with `ConversationArchivedError` when
 * `archivedAt` is non-null. Consumed by `obtainMessageSendPermission`
 * after the conversation projection lookup.
 */
export const refineConversationNotArchived = (
  conversationId: ConversationId,
  archivedAt: Date | null,
): Effect.Effect<ConversationNotArchivedValue, ConversationArchivedError> => {
  if (archivedAt !== null) {
    return Effect.fail(new ConversationArchivedError({}));
  }
  return Effect.succeed({ conversationId });
};
