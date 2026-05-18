import { Context, Effect } from "effect";
import type {
  ConversationId,
  MessageId,
} from "@moltzap/protocol/task";
import { notImplemented } from "./not-implemented.js";

/**
 * Tier 4 capabilities — reply-target presence proof.
 *
 * One of `ValidReplyTarget` / `NoReplyTarget` is required by
 * `MessagesSend` (Spec E §MessagesSend composite shape). The two tags
 * model the input-shape branch: `input.replyToId !== undefined`
 * obtains `ValidReplyTarget` (which verifies the referenced message
 * exists in the target conversation); `input.replyToId === undefined`
 * obtains the zero-payload `NoReplyTarget` constructor.
 *
 * Per Architect Decision A, these two tags are FOLDED into the
 * composite `MessageSendPermission` value (every constructor variant
 * carries one of the reply-target proofs) — they're not provided as
 * separate R-channel tags at the MessagesSend handler. They remain
 * standalone tags so D1 / future handlers can require them
 * independently if/when needed.
 */
export interface ValidReplyTargetValue {
  readonly conversationId: ConversationId;
  readonly replyToId: MessageId;
}

export class ValidReplyTarget extends Context.Tag(
  "@moltzap/server/ValidReplyTarget",
)<ValidReplyTarget, ValidReplyTargetValue>() {}

/** Zero-payload tag: declared when the send has no reply target. */
export interface NoReplyTargetValue {
  readonly _tag: "NoReplyTarget";
}

export class NoReplyTarget extends Context.Tag(
  "@moltzap/server/NoReplyTarget",
)<NoReplyTarget, NoReplyTargetValue>() {}

/**
 * Architect-stub. Body shape:
 *   const ok = yield* this.db.selectFrom("messages")...where(id =
 *     replyToId, conversation_id = conversationId);
 *   if (!ok) return yield* Effect.fail(new NotFoundError(...));
 *   return { conversationId, replyToId };
 *
 * Phase 4 promotes `MessageService.requireReplyTarget` from `private`
 * to `@internal` exported per Decision B (Option A); this obtain calls
 * through the service Tag.
 */
export const obtainValidReplyTarget = (
  _conversationId: ConversationId,
  _replyToId: MessageId,
): Effect.Effect<ValidReplyTargetValue, never> =>
  notImplemented("obtainValidReplyTarget") as never;

/** Synchronous constructor — no runtime check needed. */
export const noReplyTarget = (): NoReplyTargetValue => ({
  _tag: "NoReplyTarget",
});
