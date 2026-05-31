import { Context } from "effect";
import type { ConversationId, MessageId } from "../conversations.js";

/**
 * Tier 4 capabilities — reply-target presence proof.
 *
 * One of `ValidReplyTarget` / `NoReplyTarget` is required by
 * `MessagesSend`. The two tags model the input-shape branch:
 * `input.replyToId !== undefined` obtains `ValidReplyTarget` (which
 * verifies the referenced message exists in the target conversation);
 * `input.replyToId === undefined` obtains the zero-payload
 * `NoReplyTarget` constructor.
 *
 * These two tags are folded into the composite `MessageSendPermission`
 * value (every constructor variant carries one of the reply-target
 * proofs); they are not provided as separate R-channel tags at the
 * `MessagesSend` handler. They stay standalone tags so a handler can
 * require them independently.
 */
export interface ValidReplyTargetValue {
  readonly conversationId: ConversationId;
  readonly replyToId: MessageId;
}

export class ValidReplyTarget extends Context.Tag(
  "@moltzap/protocol/ValidReplyTarget",
)<ValidReplyTarget, ValidReplyTargetValue>() {}

/** Zero-payload tag: declared when the send has no reply target. */
export interface NoReplyTargetValue {
  readonly _tag: "NoReplyTarget";
}

export class NoReplyTarget extends Context.Tag(
  "@moltzap/protocol/NoReplyTarget",
)<NoReplyTarget, NoReplyTargetValue>() {}

/** Synchronous constructor — no runtime check needed. */
export const noReplyTarget = (): NoReplyTargetValue => ({
  _tag: "NoReplyTarget",
});
