import { Cause, Effect } from "effect";
import type {
  ConversationSendAccessValue,
  ConversationId,
} from "@moltzap/protocol/conversation";
import type { ForbiddenError } from "@moltzap/protocol/rpc";
import type { AgentId } from "@moltzap/protocol/identity";
import { ConversationServiceTag } from "../layer.js";
import { MessageServiceTag } from "#message";
import { catchSqlErrorAsDefect } from "#db";

/**
 * `ConversationSendAccess` obtain: prove the caller participates in the
 * conversation, then read the conversation row the send handler's guards share.
 * A `conversationId` that survives the participant check but vanishes from the
 * read is a true race (deletion) — surfaced as a defect, not a user error.
 * @param input Input value to process.
 * @param input.conversationId Value supplied to the operation.
 * @param input.senderAgentId Value supplied to the operation.
 * @returns The obtain conversation send access result.
 */
export const obtainConversationSendAccess = (input: {
  readonly conversationId: ConversationId;
  readonly senderAgentId: AgentId;
}): Effect.Effect<
  ConversationSendAccessValue,
  ForbiddenError,
  ConversationServiceTag | MessageServiceTag
> =>
  Effect.gen(function* () {
    const convService = yield* ConversationServiceTag;
    const msgService = yield* MessageServiceTag;
    // Participant check first — an unknown conversationId in the read below
    // would otherwise surface as a 500 instead of ForbiddenError.
    yield* convService.assertConversationParticipant(
      input.conversationId,
      input.senderAgentId,
    );
    const conv = yield* catchSqlErrorAsDefect(
      msgService
        .readSendConversation(input.conversationId)
        .pipe(
          Effect.catchTag("NoSuchElementException", (cause) =>
            Effect.die(new Cause.IllegalArgumentException(String(cause))),
          ),
        ),
    );
    return {
      conversationId: input.conversationId,
      appId: conv.app_id,
    };
  }).pipe(Effect.withSpan("obtainConversationSendAccess"));
