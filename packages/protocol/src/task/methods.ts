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
  TaskList,
  TaskClose,
  TaskAddParticipant,
  TaskRemoveParticipant,
  TaskClosedNotificationDefinition,
  TaskFailedNotificationDefinition,
  // Spec D1 (#598) `task/*` + `task/conversation/*` surface (singular).
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
  TaskCreate,
  TaskLeave,
  TaskList,
  TaskClose,
  TaskAddParticipant,
  TaskRemoveParticipant,
  TaskConversationCreate,
  TaskConversationList,
  TaskConversationArchive,
  TaskConversationUnarchive,
  TaskConversationAddParticipant,
  TaskConversationRemoveParticipant,
] as const;

// Spec D3 R11 — per-kind subsets of the surviving task layer.
export const nonTmAuthorityTaskRpcMethods = [
  TaskCreate,
  TaskList,
  TaskLeave,
  MessagesSend,
  MessagesList,
] as const;

export const tmOnlyTaskRpcMethods = [
  TaskClose,
  TaskAddParticipant,
  TaskRemoveParticipant,
  TaskConversationCreate,
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
