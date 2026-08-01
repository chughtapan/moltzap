/**
 * @file Public barrel for task protocol descriptors.
 */
export { TaskId, TaskNotFoundError } from "./ids.js";

export {
  assertAppOwnsTask,
  assertTaskReadAccessMatchesTask,
  TaskReadAccess,
} from "./requirements/index.js";
export type { TaskReadAccessValue } from "./requirements/index.js";

export {
  agentCallableTaskRpcMethods,
  appCallableTaskRpcMethods,
  AppId,
  DEFAULT_APP_ID,
  HookBlockedError,
  taskCallbackMethods,
  TaskClosedError,
  TaskClosedNotificationDefinition,
  TaskCreate,
  TaskCreatedNotificationDefinition,
  TaskFailedNotificationDefinition,
  TaskLeave,
  TaskList,
  taskNotifications,
  TaskRejectedError,
  TaskRequest,
  TaskUpdate,
} from "./tasks.js";

export type {
  InitialConversationInput,
  Task,
  TaskParticipant,
  TaskStatus,
  TaskUpdateParams,
  TaskUpdateResult,
} from "./tasks.js";
