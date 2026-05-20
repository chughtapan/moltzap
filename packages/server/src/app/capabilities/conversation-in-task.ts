import { Effect } from "effect";
import {
  ConversationInTask,
  type ConversationInTaskValue,
  type ConversationId,
  type TaskId,
} from "@moltzap/protocol/task";
import { TaskServiceTag } from "../layers.js";
import type { TaskServiceError } from "../../task/services/task.service.js";

export { ConversationInTask, type ConversationInTaskValue };

/**
 * Smart constructor. Phase 1 promotes
 * `TaskService.assertConversationInTask` to `@internal` exported per
 * Decision B (Option A); this helper consumes it through the service
 * Tag. `SqlError` from the underlying lookup is caught defectively
 * inside the service helper.
 *
 * @failure ForbiddenError when the conversation does not belong to the specified task
 * @failure NotFoundError when the conversation does not exist
 */
export const obtainConversationInTask = (
  taskId: TaskId,
  conversationId: ConversationId,
): Effect.Effect<ConversationInTaskValue, TaskServiceError, TaskServiceTag> =>
  Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    yield* taskService.assertConversationInTask(taskId, conversationId);
    return { taskId, conversationId };
  }).pipe(Effect.withSpan("obtainConversationInTask"));
