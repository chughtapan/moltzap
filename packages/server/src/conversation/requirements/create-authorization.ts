import { Effect } from "effect";
import type { AgentId, AgentNotFoundError } from "@moltzap/protocol/identity";
import { ConversationServiceTag } from "../layer.js";
import { catchSqlErrorAsDefect } from "#db";
import type { ConversationFullError } from "@moltzap/protocol/conversation";

/**
 * Capacity authorization for conversation creation. Validates that every
 * named target exists, then checks the resulting membership against the
 * group limit. The creator joins the conversation it opens, so it counts
 * toward the limit alongside the named targets.
 * @param agentIds Value supplied to the operation.
 * @returns The authorize conversation create capacity only result.
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
      yield* conversations.loadAgentOwners(agentIds);
      yield* conversations.assertGroupCapacity(agentIds.length + 1);
    }),
  ).pipe(Effect.withSpan("authorizeConversationCreateCapacityOnly"));
