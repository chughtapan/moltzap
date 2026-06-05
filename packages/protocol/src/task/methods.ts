export {
  AppId,
  DEFAULT_APP_ID,
  TaskId,
  TaskNotFoundError,
  TaskClosedError,
  TaskRejectedError,
  HookBlockedError,
  ParticipantNotAdmittedError,
  TaskList,
  TaskRequest,
  TaskLeave,
  TaskClose,
  TaskAddParticipant,
  TaskRemoveParticipant,
  TaskConversationCreate,
  TaskConversationList,
  TaskConversationArchive,
  TaskConversationUnarchive,
  TaskConversationAddParticipant,
  TaskConversationRemoveParticipant,
  TaskFailedNotificationDefinition,
  TaskCreatedNotificationDefinition,
  TaskClosedNotificationDefinition,
  TaskConversationCreatedNotificationDefinition,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationUnarchivedNotificationDefinition,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
} from "./tasks.js";
export type {
  TaskStatus,
  Task,
  TaskParticipant,
  InitialConversationInput,
  TaskConversationListItem,
  TaskConversationCreatedNotification,
  TaskConversationArchivedNotification,
  TaskConversationUnarchivedNotification,
  TaskConversationParticipantsAddedNotification,
  TaskConversationParticipantsRemovedNotification,
} from "./tasks.js";

import {
  TaskList,
  TaskClose,
  TaskAddParticipant,
  TaskRemoveParticipant,
  TaskClosedNotificationDefinition,
  TaskCreatedNotificationDefinition,
  TaskFailedNotificationDefinition,
  TaskRequest,
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

// The `agentCallable` / `appCallable` split is the OUTBOUND client
// catalog partition: which task RPCs a `MoltZapAgentClient` may
// originate vs which an app/TM client may.
export const agentCallableTaskRpcMethods = [
  TaskRequest,
  TaskList,
  TaskLeave,
  TaskConversationList,
] as const;

export const appCallableTaskRpcMethods = [
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
  TaskClosedNotificationDefinition,
  TaskCreatedNotificationDefinition,
  TaskFailedNotificationDefinition,
  TaskConversationCreatedNotificationDefinition,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationUnarchivedNotificationDefinition,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
] as const;
