import { Context, Effect } from "effect";
import { ConversationArchivedError } from "@moltzap/protocol";
import type { ConversationId } from "@moltzap/protocol/task";

/**
 * Tier 4 refine-shape capability — `conversation.archived_at IS NULL`.
 *
 * Refine-shape: takes the `archived_at` column read inline by the
 * caller. Folded into the composite `MessageSendPermission` value
 * for the MessagesSend path (every constructor verifies the
 * conversation is open) — see Architect Decision A. The standalone
 * inline gate in `MessageService.assertConversationOpen` is still
 * called by `sendInsertEffect`; the obtain helper is available for
 * future cutover once `message.service.ts` is restructured.
 */
export interface ConversationNotArchivedValue {
  readonly conversationId: ConversationId;
}

export class ConversationNotArchived extends Context.Tag(
  "@moltzap/server/ConversationNotArchived",
)<ConversationNotArchived, ConversationNotArchivedValue>() {}

/**
 * Refine constructor. Inlines today's archived-at check from
 * `MessageService.assertConversationOpen`. Fails with
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
