import { Context } from "effect";
import type { TaskId, AppId } from "../ids.js";
import type { ConversationId } from "../conversations.js";
import type { TaskStatus } from "../tasks.js";
import { ForbiddenError } from "../../transport/wire-errors.js";

/**
 * Permission: the caller may send to this conversation — proven by participant
 * membership. Its `obtain` does the one joined read (`conversations ⋈ tasks`)
 * after the participant check, so the value carries the shared send row the
 * downstream send permissions (`ActiveTaskPermission`,
 * `OpenConversationPermission`) read their column off instead of issuing their
 * own query. The whole send-cap chain costs one joined read, not one per check.
 * `appId` identifies the authorizing app for the task on the verdict route.
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
