import { Context, Data, Effect } from "effect";
import type {
  ConversationId,
  TaskId,
  TaskManagerAction,
  TaskMessagePayload,
} from "@moltzap/protocol/task";

export class DefaultPassthroughStorageFailed extends Data.TaggedError(
  "DefaultPassthroughStorageFailed",
)<{
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly detail: string;
}> {}

export class DefaultPassthroughTaskClosed extends Data.TaggedError(
  "DefaultPassthroughTaskClosed",
)<{
  readonly taskId: TaskId;
}> {}

export type DefaultPassthroughError =
  | DefaultPassthroughStorageFailed
  | DefaultPassthroughTaskClosed;

/**
 * The platform-default passthrough TM runs in-process with the task layer
 * (no network hop). It calls slice B `TaskService.storeMessage`, reads the
 * participant set via slice B `TaskService.listParticipants`, and returns
 * `Forward(participants \ sender)`. The per-recipient
 * `NetworkDeliveryService.send` fan-out happens AFTER `handle` returns, at
 * the task-layer switch site; any fan-out failure surfaces there with a
 * task-layer-switch-owned error tag (NOT on this method's channel).
 */
export interface DefaultPassthroughTaskManager {
  readonly handle: (
    payload: TaskMessagePayload,
  ) => Effect.Effect<TaskManagerAction, DefaultPassthroughError, never>;
}

export class DefaultPassthroughTaskManagerTag extends Context.Tag(
  "DefaultPassthroughTaskManager",
)<DefaultPassthroughTaskManagerTag, DefaultPassthroughTaskManager>() {}

export const makeDefaultPassthroughTaskManager = (): Effect.Effect<
  DefaultPassthroughTaskManager,
  never,
  never
> => {
  throw new Error("not implemented");
};
