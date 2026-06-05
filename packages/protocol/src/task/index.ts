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
  TaskList,
  TaskClose,
  TaskAddParticipant,
  TaskRemoveParticipant,
  AppId,
  DEFAULT_APP_ID,
  TaskRequest,
  TaskCreate,
  TaskLeave,
  TaskClosedNotificationDefinition,
  TaskCreatedNotificationDefinition,
  TaskFailedNotificationDefinition,
  // Per-kind catalog subsets.
  agentCallableTaskRpcMethods,
  appCallableTaskRpcMethods,
  taskCallbackMethods,
} from "./methods.js";

export type {
  TaskStatus,
  Task,
  TaskParticipant,
  InitialConversationInput,
} from "./methods.js";
