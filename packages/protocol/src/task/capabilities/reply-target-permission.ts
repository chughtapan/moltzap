import { Context } from "effect";
import type { ConversationId, MessageId } from "../conversations.js";
import { NotFoundError } from "../../transport/wire-errors.js";

/**
 * Permission: the send's reply target is allowed — either the referenced
 * message exists in the target conversation (`ValidReply`), or the send carries
 * no reply target (`NoReply`). The server `obtain` does the conditional
 * existence read only when `replyToId` is set, and fails `NotFound` when the
 * referenced message is absent.
 */
export type ReplyTargetPermissionValue =
  | { readonly _tag: "ValidReply"; readonly replyToId: MessageId }
  | { readonly _tag: "NoReply" };

export class ReplyTargetPermission extends Context.Tag(
  "@moltzap/protocol/ReplyTargetPermission",
)<ReplyTargetPermission, ReplyTargetPermissionValue>() {
  static get errors() {
    return [NotFoundError] as const;
  }
}

export type { ConversationId };
