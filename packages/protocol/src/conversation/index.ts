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
  TaskConversationCreate,
  TaskConversationList,
  TaskConversationUpdate,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationCreatedNotificationDefinition,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
  TaskConversationUnarchivedNotificationDefinition,
  agentCallableConversationRpcMethods,
  appCallableConversationRpcMethods,
  conversationNotifications,
} from "./conversations.js";
export type {
  TaskConversationArchivedNotification,
  TaskConversationCreatedNotification,
  TaskConversationListItem,
  TaskConversationParticipantsAddedNotification,
  TaskConversationParticipantsRemovedNotification,
  TaskConversationUpdateParams,
  TaskConversationUnarchivedNotification,
} from "./conversations.js";
