/**
 * Server-side re-export shim for `ConversationNotArchived` — the tag
 * class, value type, and refine helper now live in
 * `@moltzap/protocol/task/capabilities`.
 */
export {
  ConversationNotArchived,
  type ConversationNotArchivedValue,
  refineConversationNotArchived,
} from "@moltzap/protocol/task";
