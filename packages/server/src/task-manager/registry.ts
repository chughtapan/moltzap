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

  readonly invoke: (
    address: TaskManagerAddress,
    payload: TaskMessagePayload,
  ) => Effect.Effect<TaskManagerAction, TaskManagerInvokeError, never>;
}

export class TaskManagerRegistryTag extends Context.Tag("TaskManagerRegistry")<
  TaskManagerRegistryTag,
  TaskManagerRegistry
>() {}

export const mintDefaultAddress = (
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
