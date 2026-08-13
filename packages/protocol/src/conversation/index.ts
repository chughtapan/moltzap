/**
 * @file Public conversation-domain barrel.
 */

/** Re-exports the public API from `./types.js`. */
export {
  ConversationFullError,
  type ConversationId,
  conversationId,
  type MessageId,
  messageId,
  NotAParticipantError,
  conversationSchema,
} from "./types.js";
/** Re-exports the public API from `./types.js`. */
export type { Conversation } from "./types.js";
/** Re-exports the public API from `./requirements/index.js`. */
export { ConversationSendAccess } from "./requirements/index.js";
/** Re-exports the public API from `./requirements/index.js`. */
export type { ConversationSendAccessValue } from "./requirements/index.js";

/** Re-exports the public API from `./conversations.js`. */
export {
  agentConversationCreate,
  conversationNameSchema,
} from "./conversations.js";
