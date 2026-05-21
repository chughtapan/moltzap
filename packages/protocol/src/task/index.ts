/**
 * @file Public barrel for task, conversation, message, and task-manager protocol descriptors.
 */
export { ConversationId, LeaseId, MessageId, TaskId } from "./methods.js";
export {
  brandConversationId,
  brandMessageId,
  brandTaskId,
  BrandedIdDecodeError,
} from "./brand.js";

export * from "./capabilities/index.js";

export {
  TaskClosedError,
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
  inferConversationType,
  TaskCreate,
  TaskLeave,
  TaskConversationCreate,
  TaskConversationList,
  TaskConversationArchive,
  TaskConversationUnarchive,
  TaskConversationAddParticipant,
  TaskConversationRemoveParticipant,
  MessageReceivedNotificationDefinition,
  TaskClosedNotificationDefinition,
  TaskFailedNotificationDefinition,
  // Spec D1 — `task/conversation/*` notifications.
  TaskConversationCreatedNotificationDefinition,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationUnarchivedNotificationDefinition,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
  validateTmDecision,
  tmDecisionSchema,
  messageWithTmDecisionSchema,
  // Spec D3 R11 — per-kind catalog subsets.
  nonTmAuthorityTaskRpcMethods,
  tmOnlyTaskRpcMethods,
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
  TmType,
  MessageReceivedNotification,
  TmDecision,
  MessageWithTmDecision,
  // Spec D1 surface types.
  InitialConversationInput,
  TaskConversationListItem,
  TaskConversationCreatedNotification,
  TaskConversationArchivedNotification,
  TaskConversationUnarchivedNotification,
  TaskConversationParticipantsAddedNotification,
  TaskConversationParticipantsRemovedNotification,
} from "./methods.js";
