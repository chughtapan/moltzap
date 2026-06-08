import { RpcMiddleware } from "@effect/rpc";
import { Schema } from "effect";
import type { TaskId } from "#task";
import type { ConversationId } from "../types.js";
import { ConversationNotFoundError } from "../types.js";

/**
 * Requirement: proves `conversation.task_id === taskId`.
 */
export interface ConversationInTaskValue {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}

export class ConversationInTask extends RpcMiddleware.Tag<ConversationInTask>()(
  "@moltzap/protocol/ConversationInTask",
  { failure: Schema.Union(ConversationNotFoundError) },
) {}
