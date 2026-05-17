export * from "./conversations.js";
export * from "./messages.js";
export * from "./tasks.js";

import {
  ConversationsCreate,
  ConversationsList,
  ConversationsGet,
  ConversationsUpdate,
  ConversationsMute,
  ConversationsUnmute,
  ConversationsAddParticipant,
  ConversationsRemoveParticipant,
  ConversationsLeave,
  ConversationsArchive,
  ConversationsUnarchive,
  ConversationCreatedNotificationDefinition,
  ConversationUpdatedNotificationDefinition,
  ConversationArchivedNotificationDefinition,
  ConversationUnarchivedNotificationDefinition,
  ParticipantsAddedNotificationDefinition,
  ParticipantsRemovedNotificationDefinition,
} from "./conversations.js";
import {
  MessagesSend,
  MessagesList,
  MessageReceivedNotificationDefinition,
} from "./messages.js";
import {
  TasksCreate,
  TasksGet,
  TasksList,
  TasksClose,
  TasksCreateConversation,
  TasksCloseConversation,
  TasksAddParticipant,
  TasksRemoveParticipant,
  TasksStoreMessage,
  TasksGetMessages,
  TasksGetMessagesSince,
  TaskClosedNotificationDefinition,
  TaskFailedNotificationDefinition,
} from "./tasks.js";

export const taskRpcMethods = [
  ConversationsCreate,
  ConversationsList,
  ConversationsGet,
  ConversationsUpdate,
  ConversationsMute,
  ConversationsUnmute,
  ConversationsAddParticipant,
  ConversationsRemoveParticipant,
  ConversationsLeave,
  ConversationsArchive,
  ConversationsUnarchive,
  MessagesSend,
  MessagesList,
  TasksCreate,
  TasksGet,
  TasksList,
  TasksClose,
  TasksCreateConversation,
  TasksCloseConversation,
  TasksAddParticipant,
  TasksRemoveParticipant,
  TasksStoreMessage,
  TasksGetMessages,
  TasksGetMessagesSince,
] as const;

export const taskNotifications = [
  ConversationCreatedNotificationDefinition,
  ConversationUpdatedNotificationDefinition,
  ConversationArchivedNotificationDefinition,
  ConversationUnarchivedNotificationDefinition,
  ParticipantsAddedNotificationDefinition,
  ParticipantsRemovedNotificationDefinition,
  MessageReceivedNotificationDefinition,
  TaskClosedNotificationDefinition,
  TaskFailedNotificationDefinition,
] as const;
