import { Effect } from "effect";
import type { AgentId, AgentNotFoundError } from "@moltzap/protocol/identity";
import { ConversationServiceTag } from "../conversation.service.js";
import { catchSqlErrorAsDefect } from "#db";
import type { ConversationFullError } from "@moltzap/protocol/conversation";

/**
 * Capacity authorization for conversation creation. The capacity check runs
 * BEFORE the existence lookup so an oversized participants list is rejected
 * without reaching the database — the lookup's `IN` clause is bounded by the
 * group limit, not by whatever the caller sent on the wire. The creator
 * joins the conversation it opens, so it counts toward the limit alongside
 * the named targets; duplicates collapse before either check.
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
      const uniqueAgentIds = [...new Set(agentIds)];
      yield* conversations.assertGroupCapacity(uniqueAgentIds.length + 1);
      yield* conversations.loadAgentOwners(uniqueAgentIds);
    }),
  ).pipe(Effect.withSpan("authorizeConversationCreateCapacityOnly"));
