import { RpcMiddleware } from "@effect/rpc";
import { Schema } from "effect";
import type { AppId } from "#identity/apps";
import type { TaskId, TaskStatus } from "#task";
import type { ConversationId } from "../types.js";
import { ForbiddenError } from "#transport";

/**
 * Permission: the caller may send to this conversation, proven by participant
 * membership. The server obtain performs the joined read that feeds send guards.
 */
export interface ConversationSendAccessValue {
  readonly conversationId: ConversationId;
  readonly taskId: TaskId;
  readonly appId: AppId | null;
  readonly taskStatus: TaskStatus;
  readonly archivedAt: Date | null;
}

export class ConversationSendAccess extends RpcMiddleware.Tag<ConversationSendAccess>()(
  "@moltzap/protocol/ConversationSendAccess",
  { failure: Schema.Union(ForbiddenError) },
) {}
