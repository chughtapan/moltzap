import { Effect } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import type {
  ConversationCreateAuthorizationValue,
  ObtainConversationCreateAuthorizationInput,
} from "@moltzap/protocol/task";
import { ConversationServiceTag } from "../../app/layers.js";
import { catchSqlErrorAsDefect } from "../../db/effect-kysely-toolkit.js";
import type {
  AgentNotFoundError,
  ConversationFullError,
  NotInContactsError,
} from "@moltzap/protocol";

export const obtainConversationCreateAuthorization = (
  input: ObtainConversationCreateAuthorizationInput,
): Effect.Effect<
  ConversationCreateAuthorizationValue,
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
      return { ownerByAgentId };
    }),
  ).pipe(Effect.withSpan("obtainConversationCreateAuthorization"));

/**
 * Capacity-only authorization for the app-originated
 * `task/conversation/create`. A TM minting a conversation on the task's
 * behalf has no agent contact-edges of its own; the targets
 * are already gated by `requireAgentsAreInTaskParticipants` in the
 * handler, so the creator contact-policy basis does NOT apply. Only the
 * group-capacity check runs. `ownerByAgentId` is still loaded (it
 * validates every target exists and rides in the capability value).
 */
export const obtainConversationCreateCapacityOnly = (
  agentIds: ReadonlyArray<AgentId>,
): Effect.Effect<
  ConversationCreateAuthorizationValue,
  AgentNotFoundError | ConversationFullError,
  ConversationServiceTag
> =>
  catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const conversations = yield* ConversationServiceTag;
      const ownerByAgentId = yield* conversations.loadAgentOwners(agentIds);
      yield* conversations.assertGroupCapacityForCreate(agentIds);
      return { ownerByAgentId };
    }),
  ).pipe(Effect.withSpan("obtainConversationCreateCapacityOnly"));
