import { Effect } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import { ConversationServiceTag } from "#core";
import { catchSqlErrorAsDefect } from "../../db/effect-kysely-toolkit.js";
import type {
  AgentNotFoundError,
  NotInContactsError,
} from "@moltzap/protocol/identity";
import type { ConversationFullError } from "@moltzap/protocol/conversation";

interface AuthorizeConversationCreateInput {
  readonly agentIds: ReadonlyArray<AgentId>;
  readonly creatorAgentId: AgentId;
}

export const authorizeConversationCreate = (
  input: AuthorizeConversationCreateInput,
): Effect.Effect<
  void,
  AgentNotFoundError | NotInContactsError | ConversationFullError,
  ConversationServiceTag
> =>
  catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const conversations = yield* ConversationServiceTag;
      const ownerByAgentId = yield* conversations.loadAgentOwners(
        input.agentIds,
      );
      yield* conversations.assertContactPolicyForCreate(
        input.creatorAgentId,
        input.agentIds,
        ownerByAgentId,
      );
      yield* conversations.assertGroupCapacityForCreate(input.agentIds);
    }),
  ).pipe(Effect.withSpan("authorizeConversationCreate"));

/**
 * Capacity-only authorization for the app-originated
 * `app/conversation/create`. A TM minting a conversation on the task's
 * behalf has no agent contact-edges of its own; the targets
 * are already gated by `requireAgentsAreInTaskParticipants` in the
 * handler, so the creator contact-policy basis does NOT apply. Only the
 * group-capacity check runs. Loading owners still validates every target
 * exists.
 */
export const authorizeConversationCreateCapacityOnly = (
  agentIds: ReadonlyArray<AgentId>,
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
