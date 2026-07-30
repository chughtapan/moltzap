/**
 * @file Public barrel for task protocol descriptors.
 */
export { type TaskId, taskId, TaskNotFoundError } from "./ids.js";

/** Re-exports the public API from `./requirements/index.js`. */
export {
  TaskReadAccess,
  assertAppOwnsTask,
  assertTaskReadAccessMatchesTask,
} from "./requirements/index.js";
/** Re-exports the public API from `./requirements/index.js`. */
export type { TaskReadAccessValue } from "./requirements/index.js";

/** Re-exports the public API from `./tasks.js`. */
export {
  TaskClosedError,
  TaskRejectedError,
  HookBlockedError,
  taskList,
  taskUpdate,
  type AppId,
  appId,
  DEFAULT_APP_ID,
  taskRequest,
  taskCreate,
  taskLeave,
  taskClosedNotificationDefinition,
  taskCreatedNotificationDefinition,
  taskFailedNotificationDefinition,
  agentCallableTaskRpcMethods,
  appCallableTaskRpcMethods,
  taskCallbackMethods,
  taskNotifications,
} from "./tasks.js";

/** Re-exports the public API from `./tasks.js`. */
export type {
  TaskStatus,
  Task,
  TaskParticipant,
  TaskUpdateParams,
  TaskUpdateResult,
  InitialConversationInput,
} from "./tasks.js";
