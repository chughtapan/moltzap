import { Effect } from "effect";
import type { NotFoundError } from "@moltzap/protocol";
import {
  ValidReplyTarget,
  type ValidReplyTargetValue,
  NoReplyTarget,
  type NoReplyTargetValue,
  noReplyTarget,
  type ConversationId,
  type MessageId,
} from "@moltzap/protocol/task";
import { MessageServiceTag } from "../layers.js";
import { catchSqlErrorAsDefect } from "../../db/effect-kysely-toolkit.js";

export {
  ValidReplyTarget,
  type ValidReplyTargetValue,
  NoReplyTarget,
  type NoReplyTargetValue,
  noReplyTarget,
};

/**
 * Smart constructor. Delegates to `MessageService.assertReplyTarget`
 * (Phase 1 promotes the helper to `@internal` exported per Decision B
 * / Option A). `SqlError` from the underlying select is caught
 * defectively inside the service helper.
 *
 * R channel includes `MessageServiceTag` because the obtain helper
 * dereferences the (Phase-1-promoted-to-`@internal`)
 * `MessageService.assertReplyTarget` method through the service Tag.
 * @failure NotFoundError when `replyToId` does not resolve to a message in `conversationId`
 */
export const obtainValidReplyTarget = (
  conversationId: ConversationId,
  replyToId: MessageId,
): Effect.Effect<ValidReplyTargetValue, NotFoundError, MessageServiceTag> =>
  Effect.gen(function* () {
    const messages = yield* MessageServiceTag;
    yield* catchSqlErrorAsDefect(
      messages.assertReplyTarget(conversationId, replyToId),
    );
    return { conversationId, replyToId };
  }).pipe(Effect.withSpan("obtainValidReplyTarget"));
