import { Effect } from "effect";
import type {
  AgentNotFoundError,
  AgentId,
  ContactPolicyAllowsReachValue,
  NotInContactsError,
} from "@moltzap/protocol/identity";
import { ConversationServiceTag } from "#conversation";
import { catchSqlErrorAsDefect } from "#db";

/** Describes creator and targets. */
export interface CreatorAndTargets {
  readonly creatorAgentId: AgentId;
  readonly targetAgentIds: readonly AgentId[];
}

/**
 * Provides the obtain contact policy allows reach runtime value.
 * @param input Input value to process.
 * @returns The obtain contact policy allows reach result.
 */
export const obtainContactPolicyAllowsReach = (
  input: CreatorAndTargets,
): Effect.Effect<
  ContactPolicyAllowsReachValue,
  AgentNotFoundError | NotInContactsError,
  ConversationServiceTag
> =>
  catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const conversations = yield* ConversationServiceTag;
      const ownerByAgentId = yield* conversations.loadAgentOwners(
        input.targetAgentIds,
      );
      yield* conversations.assertContactPolicyForCreate(
        input.creatorAgentId,
        input.targetAgentIds,
        ownerByAgentId,
      );
      return {
        creatorAgentId: input.creatorAgentId,
        targetAgentIds: input.targetAgentIds,
      };
    }),
  ).pipe(Effect.withSpan("obtainContactPolicyForCreate"));
