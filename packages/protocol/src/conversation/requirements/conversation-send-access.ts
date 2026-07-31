import { RpcMiddleware } from "@effect/rpc";
import { Schema } from "effect";
import type { AppId } from "#identity/apps";
import type { ConversationId } from "../types.js";
import { ForbiddenError } from "#transport";

/**
 * Permission: the caller may send to this conversation, proven by participant
 * membership. The server obtain performs the joined read that feeds send
 * guards; `appId` is the conversation's authorizing app.
 */
export interface ConversationSendAccessValue {
  readonly conversationId: ConversationId;
  readonly appId: AppId;
}

/** Implements conversation send access. */
export class ConversationSendAccess extends RpcMiddleware.Tag<ConversationSendAccess>()(
  "@moltzap/protocol/ConversationSendAccess",
  { failure: Schema.Union(ForbiddenError) },
) {}
