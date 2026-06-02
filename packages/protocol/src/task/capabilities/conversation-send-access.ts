import { Context } from "effect";
import type { TaskId, AppId } from "../ids.js";
import type { ConversationId } from "../conversations.js";
import type { TaskStatus } from "../tasks.js";
import { ForbiddenError } from "../../transport/wire-errors.js";

/**
 * Permission: the caller may send to this conversation — proven by participant
 * membership. Its `obtain` does the one joined read (`conversations ⋈ tasks`)
 * after the participant check, and the value carries that send row to the
 * handler. The remaining send preconditions (task-active,
 * conversation-not-archived, reply-target) are handler-body guards that refine
 * this row — `@effect/rpc` middlewares cannot read each other's provided value,
 * so a refinement of the fetched row is a handler guard, not a standalone
 * middleware. The whole send path costs one joined read. `appId` identifies the
 * authorizing app for the task on the verdict route.
 */
export interface ConversationSendAccessValue {
  readonly conversationId: ConversationId;
  readonly taskId: TaskId;
  readonly appId: AppId | null;
  readonly taskStatus: TaskStatus;
  readonly archivedAt: Date | null;
}

export class ConversationSendAccess extends Context.Tag(
  "@moltzap/protocol/ConversationSendAccess",
)<ConversationSendAccess, ConversationSendAccessValue>() {
  static get errors() {
    return [ForbiddenError] as const;
  }
}
