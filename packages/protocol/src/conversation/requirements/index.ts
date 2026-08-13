/**
 * @file Conversation-owned requirement middleware tags.
 */
import { RpcMiddleware } from "@effect/rpc";
import { Schema } from "effect";

import { ForbiddenError } from "#transport";
import type { ConversationId } from "../types.js";

/**
 * Permission: the caller may send to this conversation, proven by participant
 * membership. The server obtain performs the read that feeds send guards.
 */
export interface ConversationSendAccessValue {
  readonly conversationId: ConversationId;
}

/** Implements conversation send access. */
export class ConversationSendAccess extends RpcMiddleware.Tag<ConversationSendAccess>()(
  "@moltzap/protocol/ConversationSendAccess",
  { failure: Schema.Union(ForbiddenError) },
) {}
