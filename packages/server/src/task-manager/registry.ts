import { Context, Data, Effect } from "effect";
import type {
  AgentId,
  AppId,
  TaskId,
  TaskManagerAction,
  TaskManagerAddress,
  TaskManagerEndpointRegistration,
  TaskMessagePayload,
} from "@moltzap/protocol/task";
import type { EndpointAddress } from "../app/network-layer.js";

/**
 * Narrowing coercion: a `TaskManagerAddress` IS an endpoint address in the
 * slice-A sense. The branded subtype is re-branded at the boundary where a
 * `NetworkDeliveryService.send` call needs an `EndpointAddress`.
 */
export const toEndpointAddress = (_address: TaskManagerAddress): EndpointAddress => {
  throw new Error("not implemented");
};

export class TaskManagerAddressTaken extends Data.TaggedError("TaskManagerAddressTaken")<{
  readonly taskId: TaskId;
  readonly address: TaskManagerAddress;
}> {}

export class TaskManagerTaskNotFound extends Data.TaggedError("TaskManagerTaskNotFound")<{
  readonly taskId: TaskId;
}> {}

export class TaskManagerAddressNotFound extends Data.TaggedError("TaskManagerAddressNotFound")<{
  readonly address: TaskManagerAddress;
}> {}

export class TaskManagerDispatchFailed extends Data.TaggedError("TaskManagerDispatchFailed")<{
  readonly address: TaskManagerAddress;
  readonly cause: "timeout" | "transport" | "handler";
  readonly detail: string;
}> {}

export type TaskManagerRegistryError =
  | TaskManagerAddressTaken
  | TaskManagerTaskNotFound
  | TaskManagerAddressNotFound;

export type TaskManagerInvokeError =
  | TaskManagerAddressNotFound
  | TaskManagerDispatchFailed;

export interface TaskManagerRegistry {
  readonly register: (
    registration: TaskManagerEndpointRegistration,
  ) => Effect.Effect<void, TaskManagerAddressTaken | TaskManagerTaskNotFound, never>;

  readonly resolveByTask: (
    taskId: TaskId,
  ) => Effect.Effect<TaskManagerEndpointRegistration, TaskManagerTaskNotFound, never>;

  readonly resolveByAddress: (
    address: TaskManagerAddress,
  ) => Effect.Effect<TaskManagerEndpointRegistration, TaskManagerAddressNotFound, never>;

  /**
   * Uniform dispatch by endpoint kind:
   *   - `default-dm`    → in-process `DefaultDmTaskManager.handle`
   *   - `default-group` → in-process `DefaultGroupTaskManager.handle`
   *   - `app`           → calls slice B `TaskService.getTask(taskId)`,
   *                       `TaskService.listParticipants(taskId)`, and
   *                       `TaskService.listConversations(taskId)` to populate
   *                       `TaskManagerContext` (`appId`, `initiatorAgentId`,
   *                       `participantIds`, `conversationIds`), then dispatches
   *                       over the app's WS.
   * `TaskNotFound` from any of the metadata reads lifts to
   * `TaskManagerDispatchFailed{cause: "metadata"}`. Round-3 codex follow-up:
   * `listConversations` owner is now explicit on this method.
   */
  readonly invoke: (
    address: TaskManagerAddress,
    payload: TaskMessagePayload,
  ) => Effect.Effect<TaskManagerAction, TaskManagerInvokeError, never>;
}

export class TaskManagerRegistryTag extends Context.Tag("TaskManagerRegistry")<
  TaskManagerRegistryTag,
  TaskManagerRegistry
>() {}

/**
 * Mint a `tm:default-dm:<taskId>:v1`-shaped address for a platform-default DM
 * endpoint. Slice C owns three kinds: `default-dm`, `default-group`, `app`
 * (spec #137 round-2 goal 2).
 */
export const mintDefaultDmAddress = (
  _taskId: TaskId,
): Effect.Effect<TaskManagerAddress, never, never> => {
  throw new Error("not implemented");
};

/**
 * Mint a `tm:default-group:<taskId>:v1`-shaped address for the platform-default
 * group passthrough endpoint.
 */
export const mintDefaultGroupAddress = (
  _taskId: TaskId,
): Effect.Effect<TaskManagerAddress, never, never> => {
  throw new Error("not implemented");
};

export const mintAppAddress = (
  _taskId: TaskId,
  _appId: AppId,
  _agentId: AgentId,
): Effect.Effect<TaskManagerAddress, never, never> => {
  throw new Error("not implemented");
};
