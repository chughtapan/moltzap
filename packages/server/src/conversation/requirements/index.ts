/** @file Conversation-domain requirement helpers. */

import type {
  ConversationFullError,
  ConversationId,
  ConversationSendAccessValue,
} from "@moltzap/protocol/conversation";
import type { AgentId, AgentNotFoundError } from "@moltzap/protocol/identity";
import type { ForbiddenError } from "@moltzap/protocol/rpc";
import { Cause, Effect } from "effect";

import { catchSqlErrorAsDefect } from "#db";
import { MessageServiceTag } from "#message";
import { ConversationServiceTag } from "../conversation.service.js";

/**
 * Capacity authorization for conversation creation. The capacity check runs
 * before the existence lookup so the database query remains bounded by the
 * group limit. The creator counts toward the limit and duplicate targets
 * collapse before either check.
 * @param agentIds Target agent identities.
 * @returns Completion after capacity and owner validation.
 */
export const authorizeConversationCreateCapacityOnly = (
  agentIds: readonly AgentId[],
): Effect.Effect<
  void,
  AgentNotFoundError | ConversationFullError,
  ConversationServiceTag
> =>
  catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const conversations = yield* ConversationServiceTag;
      const uniqueAgentIds = [...new Set(agentIds)];
      yield* conversations.assertGroupCapacity(uniqueAgentIds.length + 1);
      yield* conversations.loadAgentOwners(uniqueAgentIds);
    }),
  ).pipe(Effect.withSpan("authorizeConversationCreateCapacityOnly"));

/**
 * Proves that the caller participates in a still-present conversation.
 * Participant rejection precedes the row read so an unknown conversation is
 * a typed authorization failure, while deletion between checks is a defect.
 * @param input Conversation and sender identities.
 * @param input.conversationId Conversation being authorized.
 * @param input.senderAgentId Agent requesting send access.
 * @returns The proven conversation send access value.
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
    yield* convService.assertConversationParticipant(
      input.conversationId,
      input.senderAgentId,
    );
    yield* catchSqlErrorAsDefect(
      msgService
        .readSendConversation(input.conversationId)
        .pipe(
          Effect.catchTag("NoSuchElementException", (cause) =>
            Effect.die(new Cause.IllegalArgumentException(String(cause))),
          ),
        ),
    );
    return { conversationId: input.conversationId };
  }).pipe(Effect.withSpan("obtainConversationSendAccess"));
