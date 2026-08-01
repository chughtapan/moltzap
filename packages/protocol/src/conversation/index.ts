/**
 * @file Public conversation-domain barrel.
 */

export {
  ConversationArchivedError,
  ConversationFullError,
  ConversationId,
  ConversationNotFoundError,
  conversationSchema,
  MessageId,
  NotAParticipantError,
  ParticipantNotAdmittedError,
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
  agentCallableConversationRpcMethods,
  appCallableConversationRpcMethods,
  ConversationArchivedNotificationDefinition,
  ConversationCreate,
  ConversationCreatedNotificationDefinition,
  ConversationList,
  conversationNotifications,
  ConversationParticipantsAddedNotificationDefinition,
  ConversationParticipantsRemovedNotificationDefinition,
  ConversationUnarchivedNotificationDefinition,
  ConversationUpdate,
} from "./conversations.js";
export type {
  ConversationArchivedNotification,
  ConversationCreatedNotification,
  ConversationListItem,
  ConversationParticipantsAddedNotification,
  ConversationParticipantsRemovedNotification,
  ConversationUnarchivedNotification,
  ConversationUpdateParams,
} from "./conversations.js";
