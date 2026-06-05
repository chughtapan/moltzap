export {
  ConversationId,
  MessageId,
  ConversationNotFoundError,
  NotAParticipantError,
  ConversationArchivedError,
  ConversationFullError,
} from "./conversations.js";
export type {
  Conversation,
  ConversationParticipant,
  ConversationSummary,
} from "./conversations.js";

export {
  MessageNotFoundError,
  validateTextPart,
  validateMessage,
  messagePartsSchema,
  LeaseId,
  MessagesSend,
  MessagesList,
  MessageReceivedNotificationDefinition,
  validateDispatchDecision,
  dispatchDecisionSchema,
  messageWithDispatchDecisionSchema,
} from "./messages.js";
export type {
  Part,
  Message,
  MessageReceivedNotification,
  DispatchDecision,
  MessageWithDispatchDecision,
} from "./messages.js";

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

import { MessagesSend, MessagesList } from "./messages.js";
import { MessageReceivedNotificationDefinition } from "./messages.js";
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
  MessagesSend,
  MessagesList,
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
  MessageReceivedNotificationDefinition,
  TaskClosedNotificationDefinition,
  TaskCreatedNotificationDefinition,
  TaskFailedNotificationDefinition,
  TaskConversationCreatedNotificationDefinition,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationUnarchivedNotificationDefinition,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
] as const;
