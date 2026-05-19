import { Context, Effect } from "effect";
import { ConversationArchivedError } from "@moltzap/protocol";
import type { ConversationId } from "@moltzap/protocol/task";

/**
 * Tier 4 refine-shape capability — `conversation.archived_at IS NULL`.
 *
 * Refine-shape: takes the `archived_at` column read inline by the
 * caller. Replaces (Phase 4):
 * `MessageService.requireConversationOpen` standalone consumers.
 *
 * In MessagesSend, this proof is folded into the composite
 * `MessageSendPermission` value (every constructor verifies the
 * conversation is open) — see Architect Decision A.
 */
export interface ConversationNotArchivedValue {
  readonly conversationId: ConversationId;
}

export class ConversationNotArchived extends Context.Tag(
  "@moltzap/server/ConversationNotArchived",
)<ConversationNotArchived, ConversationNotArchivedValue>() {}

/**
 * Refine constructor. Inlines today's archived-at check from
 * `MessageService.requireConversationOpen`. Fails with
 * `ConversationArchivedError` when `archivedAt` is non-null.
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
