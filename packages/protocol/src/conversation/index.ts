/**
 * @file Public conversation-domain barrel.
 */

/** Re-exports the public API from `./types.js`. */
export {
  ConversationFullError,
  type ConversationId,
  conversationId,
  ConversationNotFoundError,
  type MessageId,
  messageId,
  NotAParticipantError,
  conversationSchema,
} from "./types.js";
/** Re-exports the public API from `./types.js`. */
export type {
  Conversation,
  ConversationParticipant,
  ConversationSummary,
} from "./types.js";
/** Re-exports the public API from `./name.js`. */
export { conversationNameSchema } from "./name.js";

/** Re-exports the public API from `./requirements/index.js`. */
export { ConversationSendAccess } from "./requirements/index.js";
/** Re-exports the public API from `./requirements/index.js`. */
export type { ConversationSendAccessValue } from "./requirements/index.js";

/** Re-exports the public API from `./conversations.js`. */
export {
  agentConversationCreate,
  conversationCreate,
  conversationList,
  conversationUpdate,
  conversationCreatedNotificationDefinition,
  conversationParticipantsAddedNotificationDefinition,
  conversationParticipantsRemovedNotificationDefinition,
  agentCallableConversationRpcMethods,
  appCallableConversationRpcMethods,
  conversationNotifications,
} from "./conversations.js";
/** Re-exports the public API from `./conversations.js`. */
export type {
  ConversationCreatedNotification,
  ConversationListItem,
  ConversationParticipantsAddedNotification,
  ConversationParticipantsRemovedNotification,
  ConversationUpdateParams,
} from "./conversations.js";
