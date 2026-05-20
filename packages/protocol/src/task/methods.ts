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
  // Spec D1 (#598) — additive `task/*` + `task/conversation/*` surface.
  // Both old and new families coexist until D3 (#600) deletes the legacy
  // `Tasks*` / `Conversations*` entries above.
  TaskCreate,
  TaskLeave,
  TaskConversationCreate,
  TaskConversationList,
  TaskConversationArchive,
  TaskConversationUnarchive,
  TaskConversationAddParticipant,
  TaskConversationRemoveParticipant,
  TaskConversationCreatedNotificationDefinition,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationUnarchivedNotificationDefinition,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
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
  // Spec D1 additions. Order: TaskCreate / TaskLeave first (task-level
  // operations), then the `task/conversation/*` admin set.
  TaskCreate,
  TaskLeave,
  TaskConversationCreate,
  TaskConversationList,
  TaskConversationArchive,
  TaskConversationUnarchive,
  TaskConversationAddParticipant,
  TaskConversationRemoveParticipant,
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
  // Spec D1: dual-emit alongside the legacy `conversations/*` set.
  // D3 deletes the legacy entries; this block becomes canonical.
  TaskConversationCreatedNotificationDefinition,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationUnarchivedNotificationDefinition,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
] as const;
