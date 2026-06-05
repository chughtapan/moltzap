/**
 * @file Public barrel for task protocol descriptors.
 */
export { TaskId } from "./methods.js";

export {
  TaskReadAccess,
  ConversationInTask,
  ConversationSendAccess,
  ContactPolicyAllowsReach,
  assertAppOwnsTask,
  assertConversationInTaskMatches,
  assertTaskReadAccessMatchesTask,
} from "./capabilities/index.js";
export type {
  TaskReadAccessValue,
  ConversationInTaskValue,
  ConversationSendAccessValue,
  ContactPolicyAllowsReachValue,
} from "./capabilities/index.js";

export {
  TaskClosedError,
  TaskNotFoundError,
  TaskRejectedError,
  HookBlockedError,
  ParticipantNotAdmittedError,
  TaskList,
  TaskClose,
  TaskAddParticipant,
  TaskRemoveParticipant,
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
  TaskClosedNotificationDefinition,
  TaskCreatedNotificationDefinition,
  TaskFailedNotificationDefinition,
  TaskConversationCreatedNotificationDefinition,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationUnarchivedNotificationDefinition,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
  // Per-kind catalog subsets.
  agentCallableTaskRpcMethods,
  appCallableTaskRpcMethods,
} from "./methods.js";

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
} from "./methods.js";
