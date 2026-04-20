import { Context, Data, Effect } from "effect";
import type {
  AgentId,
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

export class DefaultPassthroughFanoutFailed extends Data.TaggedError(
  "DefaultPassthroughFanoutFailed",
)<{
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly failedRecipients: readonly AgentId[];
}> {}

export class DefaultPassthroughTaskClosed extends Data.TaggedError(
  "DefaultPassthroughTaskClosed",
)<{
  readonly taskId: TaskId;
}> {}

export type DefaultPassthroughError =
  | DefaultPassthroughStorageFailed
  | DefaultPassthroughFanoutFailed
  | DefaultPassthroughTaskClosed;

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
