import { Context } from "effect";
import {
  ConversationArchivedError,
  type ConversationId,
} from "../conversations.js";

/**
 * Permission: sending is allowed only while the conversation is open
 * (`archived_at IS NULL`). The server `obtain` reads the `archivedAt` column off
 * the shared `ConversationSendAccess` row — no DB call of its own — and fails
 * `ConversationArchived` when the conversation is archived.
 */
export interface OpenConversationPermissionValue {
  readonly conversationId: ConversationId;
}

export class OpenConversationPermission extends Context.Tag(
  "@moltzap/protocol/OpenConversationPermission",
)<OpenConversationPermission, OpenConversationPermissionValue>() {
  static get errors() {
    return [ConversationArchivedError] as const;
  }
}
