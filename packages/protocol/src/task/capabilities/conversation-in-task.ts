import { Schema } from "effect";
import { RpcMiddleware } from "@effect/rpc";
import type { ConversationId } from "../../conversation/types.js";
import { ConversationNotFoundError } from "../../conversation/types.js";
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

export class ConversationInTask extends RpcMiddleware.Tag<ConversationInTask>()(
  "@moltzap/protocol/ConversationInTask",
  { failure: Schema.Union(ConversationNotFoundError) },
) {}
