import { Effect } from "effect";
import type { AgentId, AgentNotFoundError } from "@moltzap/protocol/identity";
import { ConversationServiceTag } from "../layer.js";
import { catchSqlErrorAsDefect } from "#db";
import type { ConversationFullError } from "@moltzap/protocol/conversation";

/**
 * Capacity-only authorization for the app-originated
 * `app/conversation/create`. An app minting a conversation on the task's
 * behalf has no agent contact-edges of its own; the targets
 * are already gated by `requireAgentsAreInTaskParticipants` in the
 * handler, so the creator contact-policy basis does NOT apply. Only the
 * group-capacity check runs. Loading owners still validates every target
 * exists.
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
      yield* conversations.assertGroupCapacityForCreate(agentIds);
    }),
  ).pipe(Effect.withSpan("authorizeConversationCreateCapacityOnly"));
