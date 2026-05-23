import { Effect } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import {
  ContactPolicyAllowsReach,
  type ContactPolicyAllowsReachValue,
} from "@moltzap/protocol/task";
import { ConversationServiceTag } from "../layers.js";
import type { ConversationServiceError } from "../../task/services/conversation.service.js";
import { catchSqlErrorAsDefect } from "../../db/effect-kysely-toolkit.js";

export { ContactPolicyAllowsReach, type ContactPolicyAllowsReachValue };

export const obtainContactPolicyForCreate = (
  creatorAgentId: AgentId,
  targetAgentIds: readonly AgentId[],
): Effect.Effect<
  ContactPolicyAllowsReachValue,
  ConversationServiceError,
  ConversationServiceTag
> =>
  catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const conversations = yield* ConversationServiceTag;
      const ownerByAgentId =
        yield* conversations.loadAgentOwners(targetAgentIds);
      yield* conversations.assertContactPolicyForCreate(
        creatorAgentId,
        targetAgentIds,
        ownerByAgentId,
      );
      return { creatorAgentId, targetAgentIds };
    }),
  ).pipe(Effect.withSpan("obtainContactPolicyForCreate"));
