import { Context, Effect } from "effect";
import type {
  ConversationArchivedError,
  ConversationId,
} from "@moltzap/protocol/task";
import { notImplemented } from "./not-implemented.js";

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
 * Architect-stub refine constructor. Body shape:
 *   if (archivedAt !== null) return yield* Effect.fail(new
 *     ConversationArchivedError({}));
 *   return { conversationId };
 */

/**
 * Error channel — fails with `ConversationArchivedError` when
 * `archivedAt` is non-null. Pure refine; no R dependency.
 */
export const refineConversationNotArchived = (
  _conversationId: ConversationId,
  _archivedAt: Date | null,
): Effect.Effect<ConversationNotArchivedValue, ConversationArchivedError> =>
  notImplemented("refineConversationNotArchived") as never;
