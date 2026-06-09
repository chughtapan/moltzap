import { Effect } from "effect";
import type {
  AgentId,
  ContactPolicyAllowsReachValue,
} from "@moltzap/protocol/identity";
import { ConversationServiceTag } from "#core";
import { catchSqlErrorAsDefect } from "../../../db/effect-kysely-toolkit.js";

export interface CreatorAndTargets {
  readonly creatorAgentId: AgentId;
  readonly targetAgentIds: readonly AgentId[];
}

export const obtainContactPolicyAllowsReach = (
  input: CreatorAndTargets,
): Effect.Effect<
  ContactPolicyAllowsReachValue,
  unknown,
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
