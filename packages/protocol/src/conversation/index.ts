/**
 * @file Public conversation-domain barrel.
 */

export {
  ConversationArchivedError,
  ConversationFullError,
  ConversationId,
  ConversationNotFoundError,
  MessageId,
  NotAParticipantError,
  ParticipantNotAdmittedError,
  conversationSchema,
} from "./types.js";
export type {
  Conversation,
  ConversationParticipant,
  ConversationSummary,
} from "./types.js";

export {
  ConversationInTask,
  ConversationSendAccess,
} from "./requirements/index.js";
export type {
  ConversationInTaskValue,
  ConversationSendAccessValue,
} from "./requirements/index.js";

export {
  ConversationCreate,
  ConversationList,
  ConversationUpdate,
  ConversationArchivedNotificationDefinition,
  ConversationCreatedNotificationDefinition,
  ConversationParticipantsAddedNotificationDefinition,
  ConversationParticipantsRemovedNotificationDefinition,
  ConversationUnarchivedNotificationDefinition,
  agentCallableConversationRpcMethods,
  appCallableConversationRpcMethods,
  conversationNotifications,
} from "./conversations.js";
export type {
  ConversationArchivedNotification,
  ConversationCreatedNotification,
  ConversationListItem,
  ConversationParticipantsAddedNotification,
  ConversationParticipantsRemovedNotification,
  ConversationUpdateParams,
  ConversationUnarchivedNotification,
} from "./conversations.js";
