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
  TaskConversationAddParticipant,
  TaskConversationArchive,
  TaskConversationCreate,
  TaskConversationList,
  TaskConversationRemoveParticipant,
  TaskConversationUnarchive,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationCreatedNotificationDefinition,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
  TaskConversationUnarchivedNotificationDefinition,
  agentCallableConversationRpcMethods,
  appCallableConversationRpcMethods,
  conversationNotifications,
} from "./methods.js";
export type {
  TaskConversationArchivedNotification,
  TaskConversationCreatedNotification,
  TaskConversationListItem,
  TaskConversationParticipantsAddedNotification,
  TaskConversationParticipantsRemovedNotification,
  TaskConversationUnarchivedNotification,
} from "./methods.js";
