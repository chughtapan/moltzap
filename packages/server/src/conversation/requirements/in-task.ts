import { Effect } from "effect";
import {
  type ConversationId,
  type ConversationInTaskValue,
  ConversationNotFoundError,
} from "@moltzap/protocol/conversation";
import type { TaskId } from "@moltzap/protocol/task";
import { TaskServiceTag } from "#task";

export interface TaskAndConversation {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}

export const obtainConversationInTask = (
  input: TaskAndConversation,
): Effect.Effect<
  ConversationInTaskValue,
  ConversationNotFoundError,
  TaskServiceTag
> =>
  Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    yield* taskService
      .assertConversationInTask(input.taskId, input.conversationId)
      .pipe(
        Effect.catchTag("Forbidden", () =>
          Effect.fail(
            new ConversationNotFoundError({
              message: "Conversation not found in task",
            }),
          ),
        ),
      );
    return { taskId: input.taskId, conversationId: input.conversationId };
  }).pipe(Effect.withSpan("obtainConversationInTask"));
