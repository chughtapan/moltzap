import { RpcMiddleware } from "@effect/rpc";
import { Schema } from "effect";
import type { TaskId } from "#task";
import { type ConversationId, ConversationNotFoundError } from "../types.js";

/**
 * Requirement: proves `conversation.task_id === taskId`.
 */
export interface ConversationInTaskValue {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}

/** Implements conversation in task. */
export class ConversationInTask extends RpcMiddleware.Tag<ConversationInTask>()(
  "@moltzap/protocol/ConversationInTask",
  { failure: Schema.Union(ConversationNotFoundError) },
) {}
