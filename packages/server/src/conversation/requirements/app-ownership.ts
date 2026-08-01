// safer-arch-ignore folder-readme-required: the folder boundary is described in conversation/requirements/README.md, which the checker does not discover at this nesting depth.
import { Effect } from "effect";
import type { AppId } from "@moltzap/protocol/identity";
import type {
  ConversationId,
  ConversationNotFoundError,
} from "@moltzap/protocol/conversation";
import { ForbiddenError } from "@moltzap/protocol/rpc";
import { ConversationServiceTag } from "../layer.js";

const ERR_NOT_CONVERSATION_APP =
  "Caller is not the app that owns this conversation";

/**
 * App-principal ownership gate. App conversation-mutation handlers call this
 * before the service mutation; it compares the calling AppConnection's appId
 * against the conversation's routing key.
 * @param appId Value supplied to the operation.
 * @param conversationId Value supplied to the operation.
 * @returns The assert caller app owns conversation result.
 */
export const assertCallerAppOwnsConversation = (
  appId: AppId,
  conversationId: ConversationId,
): Effect.Effect<
  void,
  ForbiddenError | ConversationNotFoundError,
  ConversationServiceTag
> =>
  Effect.gen(function* () {
    const conversations = yield* ConversationServiceTag;
    const owner = yield* conversations.loadAppId(conversationId);
    if (owner !== appId) {
      return yield* Effect.fail(
        new ForbiddenError({ message: ERR_NOT_CONVERSATION_APP }),
      );
    }
  }).pipe(Effect.withSpan("conversation.assertCallerAppOwnsConversation"));
