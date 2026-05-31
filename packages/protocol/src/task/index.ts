/**
 * @file Public barrel for task, conversation, message, and task-manager protocol descriptors.
 */
export { ConversationId, LeaseId, MessageId, TaskId } from "./methods.js";

export * from "./capabilities/index.js";

export {
  TaskClosedError,
  TaskRejectedError,
  ConversationArchivedError,
  ConversationFullError,
  HookBlockedError,
  // Spec D1 (#598) — new tagged error for `task/conversation/*`
  // participant invariant.
  ParticipantNotAdmittedError,
  MessagesSend,
  MessagesList,
  TaskList,
  TaskClose,
  TaskAddParticipant,
  TaskRemoveParticipant,
  // Spec D1 — `task/*` + `task/conversation/*` family.
  AppId,
  DEFAULT_APP_ID,
  TaskRequest,
  TaskLeave,
  TaskConversationCreate,
  TaskConversationList,
  TaskConversationArchive,
  TaskConversationUnarchive,
  TaskConversationAddParticipant,
  TaskConversationRemoveParticipant,
  MessageReceivedNotificationDefinition,
  TaskClosedNotificationDefinition,
  TaskCreatedNotificationDefinition,
  TaskFailedNotificationDefinition,
  // Spec D1 — `task/conversation/*` notifications.
  TaskConversationCreatedNotificationDefinition,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationUnarchivedNotificationDefinition,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
  validateDispatchDecision,
  dispatchDecisionSchema,
  messageWithDispatchDecisionSchema,
  // Spec D3 R11 — per-kind catalog subsets.
  agentCallableTaskRpcMethods,
  appCallableTaskRpcMethods,
} from "./methods.js";

export type {
  LogicalClock,
  Part,
  Message,
  Conversation,
  ConversationParticipant,
  ConversationSummary,
  TaskStatus,
  Task,
  TaskParticipant,
  MessageReceivedNotification,
  DispatchDecision,
  MessageWithDispatchDecision,
  // Spec D1 surface types.
  InitialConversationInput,
  TaskConversationListItem,
  TaskConversationCreatedNotification,
  TaskConversationArchivedNotification,
  TaskConversationUnarchivedNotification,
  TaskConversationParticipantsAddedNotification,
  TaskConversationParticipantsRemovedNotification,
} from "./methods.js";
