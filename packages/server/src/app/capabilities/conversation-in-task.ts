import { Context, Effect } from "effect";
import type { ConversationId, TaskId } from "@moltzap/protocol/task";
import { TaskServiceTag } from "../layers.js";
import { notImplemented } from "./not-implemented.js";

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
 * Architect-stub. Phase 2 promotes `TaskService.requireConversationInTask`
 * from `private` to `@internal` exported per Decision B (Option A).
 *
 * Body shape:
 *   const taskService = yield* TaskServiceTag;
 *   yield* taskService.requireConversationInTask(taskId, conversationId);
 *   return { taskId, conversationId };
 */
export const obtainConversationInTask = (
  _taskId: TaskId,
  _conversationId: ConversationId,
): Effect.Effect<ConversationInTaskValue, never, TaskServiceTag> =>
  notImplemented("obtainConversationInTask") as never;
