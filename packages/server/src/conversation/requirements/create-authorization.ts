import { Effect } from "effect";
import type { AgentId, AgentNotFoundError } from "@moltzap/protocol/identity";
import { ConversationServiceTag } from "../layer.js";
import { catchSqlErrorAsDefect } from "#db";
import type { ConversationFullError } from "@moltzap/protocol/conversation";

/**
 * Capacity authorization for conversation creation. Validates that every
 * named target exists, then checks the resulting membership against the
 * group limit. `seedsCreator` distinguishes the agent path, whose creator
 * joins the conversation, from the app path, whose membership is exactly
 * the named targets.
 * @param agentIds Value supplied to the operation.
 * @param seedsCreator Whether the creator joins the membership.
 * @returns The authorize conversation create capacity only result.
 */
export const authorizeConversationCreateCapacityOnly = (
  agentIds: readonly AgentId[],
  seedsCreator: boolean,
): Effect.Effect<
  void,
  AgentNotFoundError | ConversationFullError,
  ConversationServiceTag
> =>
  catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const conversations = yield* ConversationServiceTag;
      yield* conversations.loadAgentOwners(agentIds);
      yield* conversations.assertGroupCapacity(
        agentIds.length + (seedsCreator ? 1 : 0),
      );
    }),
  ).pipe(Effect.withSpan("authorizeConversationCreateCapacityOnly"));
