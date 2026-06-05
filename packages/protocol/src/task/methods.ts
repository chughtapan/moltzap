export {
  AppId,
  DEFAULT_APP_ID,
  TaskId,
  TaskNotFoundError,
  TaskClosedError,
  TaskRejectedError,
  HookBlockedError,
  TaskList,
  TaskRequest,
  TaskCreate,
  TaskLeave,
  TaskClose,
  TaskAddParticipant,
  TaskRemoveParticipant,
  TaskFailedNotificationDefinition,
  TaskCreatedNotificationDefinition,
  TaskClosedNotificationDefinition,
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

// The `agentCallable` / `appCallable` split is the OUTBOUND client
// catalog partition: which task RPCs a `MoltZapAgentClient` may
// originate vs which an app/TM client may.
export const agentCallableTaskRpcMethods = [
  TaskRequest,
  TaskList,
  TaskLeave,
] as const;

export const appCallableTaskRpcMethods = [
  TaskClose,
  TaskAddParticipant,
  TaskRemoveParticipant,
] as const;

export const taskCallbackMethods = [TaskCreate] as const;

export const taskNotifications = [
  TaskClosedNotificationDefinition,
  TaskCreatedNotificationDefinition,
  TaskFailedNotificationDefinition,
] as const;
