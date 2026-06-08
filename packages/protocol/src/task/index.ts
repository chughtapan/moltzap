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
} from "./tasks.js";

export type {
  TaskStatus,
  Task,
  TaskParticipant,
  InitialConversationInput,
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
  TaskCreate,
  TaskLeave,
} from "./tasks.js";

/** Task RPC catalog callable by agent clients. */
export const agentCallableTaskRpcMethods = [
  TaskRequest,
  TaskList,
  TaskLeave,
] as const;

/** Task RPC catalog callable by app clients. */
export const appCallableTaskRpcMethods = [
  TaskClose,
  TaskAddParticipant,
  TaskRemoveParticipant,
] as const;

/** Task callback catalog served by app clients for server-initiated calls. */
export const taskCallbackMethods = [TaskCreate] as const;

/** Task notification catalog emitted by the server. */
export const taskNotifications = [
  TaskClosedNotificationDefinition,
  TaskCreatedNotificationDefinition,
  TaskFailedNotificationDefinition,
] as const;
