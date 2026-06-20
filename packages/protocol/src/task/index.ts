/**
 * @file Public barrel for task protocol descriptors.
 */
export { TaskId, TaskNotFoundError } from "./ids.js";

export {
  TaskReadAccess,
  assertAppOwnsTask,
  assertTaskReadAccessMatchesTask,
} from "./requirements/index.js";
export type { TaskReadAccessValue } from "./requirements/index.js";

export {
  TaskClosedError,
  TaskRejectedError,
  HookBlockedError,
  TaskList,
  TaskUpdate,
  AppId,
  DEFAULT_APP_ID,
  TaskRequest,
  TaskCreate,
  TaskLeave,
  TaskClosedNotificationDefinition,
  TaskCreatedNotificationDefinition,
  TaskFailedNotificationDefinition,
  agentCallableTaskRpcMethods,
  appCallableTaskRpcMethods,
  taskCallbackMethods,
  taskNotifications,
} from "./tasks.js";

export type {
  TaskStatus,
  Task,
  TaskParticipant,
  TaskUpdateParams,
  TaskUpdateResult,
  InitialConversationInput,
} from "./tasks.js";
