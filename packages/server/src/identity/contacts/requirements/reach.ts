import { Effect } from "effect";
import type {
  AgentId,
  AgentNotFoundError,
  ContactPolicyAllowsReachValue,
  NotInContactsError,
} from "@moltzap/protocol/identity";
import { ConversationServiceTag } from "#conversation";
import { catchSqlErrorAsDefect } from "#db";

export interface CreatorAndTargets {
  readonly creatorAgentId: AgentId;
  readonly targetAgentIds: readonly AgentId[];
}

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
