import { Context } from "effect";
import type { ConversationId } from "../conversations.js";
import { ConversationNotFoundError } from "../conversations.js";
import type { TaskId } from "../tasks.js";

/**
 * Tier 2 capability — proves `conversation.task_id === taskId`.
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
  "@moltzap/protocol/ConversationInTask",
)<ConversationInTask, ConversationInTaskValue>() {
  static get errors() {
    return [ConversationNotFoundError] as const;
  }
}
