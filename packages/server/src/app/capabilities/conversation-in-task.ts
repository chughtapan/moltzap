import { Context, Effect } from "effect";
import type { ConversationId, TaskId } from "@moltzap/protocol/task";
import { TaskServiceTag } from "../layers.js";
import type { TaskServiceError } from "../../task/services/task.service.js";

/**
 * Tier 2 capability — proves `conversation.task_id === taskId`.
 *
 * Replaces (Phase 2): every `yield* this.requireConversationInTask(id,
 * input.conversationId)` call site (`storeMessage`, `getMessages`,
 * `getMessagesSince`, `closeConversation` indirectly via
 * `archiveConversationInTask`).
 *
 * `assertCapabilityMatchesTask` (see `assert-capability-matches-task.ts`)
 * verifies the carried `taskId` matches the handler-input `taskId` at
 * call time — the one-line runtime check that catches "handler passed
 * a different taskId than the obtain proved".
 */
export interface ConversationInTaskValue {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}

export class ConversationInTask extends Context.Tag(
  "@moltzap/server/ConversationInTask",
)<ConversationInTask, ConversationInTaskValue>() {}

/**
 * Smart constructor. Phase 1 promotes
 * `TaskService.requireConversationInTask` to `@internal` exported per
 * Decision B (Option A); this helper consumes it through the service
 * Tag.
 *
 * Error channel — propagates the helper's `ForbiddenError`
 * ("Conversation does not belong to the specified task") and
 * `NotFoundError` ("Conversation not found"). `SqlError` from the
 * underlying lookup is caught defectively inside the service helper.
 */
export const obtainConversationInTask = (
  taskId: TaskId,
  conversationId: ConversationId,
): Effect.Effect<ConversationInTaskValue, TaskServiceError, TaskServiceTag> =>
  Effect.gen(function* () {
    const taskService = yield* TaskServiceTag;
    yield* taskService.requireConversationInTask(taskId, conversationId);
    return { taskId, conversationId };
  }).pipe(Effect.withSpan("obtainConversationInTask"));
