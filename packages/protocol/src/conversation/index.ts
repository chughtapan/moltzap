/**
 * @file Public conversation-domain barrel.
 */

/** Re-exports the public API from `./types.js`. */
export {
  ConversationArchivedError,
  ConversationFullError,
  type ConversationId,
  conversationId,
  ConversationNotFoundError,
  type MessageId,
  messageId,
  NotAParticipantError,
  ParticipantNotAdmittedError,
  conversationSchema,
} from "./types.js";
/** Re-exports the public API from `./types.js`. */
export type {
  Conversation,
  ConversationParticipant,
  ConversationSummary,
} from "./types.js";

/** Re-exports the public API from `./requirements/index.js`. */
export {
  ConversationInTask,
  ConversationSendAccess,
} from "./requirements/index.js";
/** Re-exports the public API from `./requirements/index.js`. */
export type {
  ConversationInTaskValue,
  ConversationSendAccessValue,
} from "./requirements/index.js";

/** Re-exports the public API from `./conversations.js`. */
export {
  conversationCreate,
  conversationList,
  conversationUpdate,
  conversationArchivedNotificationDefinition,
  conversationCreatedNotificationDefinition,
  conversationParticipantsAddedNotificationDefinition,
  conversationParticipantsRemovedNotificationDefinition,
  conversationUnarchivedNotificationDefinition,
  agentCallableConversationRpcMethods,
  appCallableConversationRpcMethods,
  conversationNotifications,
} from "./conversations.js";
/** Re-exports the public API from `./conversations.js`. */
export type {
  ConversationArchivedNotification,
  ConversationCreatedNotification,
  ConversationListItem,
  ConversationParticipantsAddedNotification,
  ConversationParticipantsRemovedNotification,
  ConversationUpdateParams,
  ConversationUnarchivedNotification,
} from "./conversations.js";
