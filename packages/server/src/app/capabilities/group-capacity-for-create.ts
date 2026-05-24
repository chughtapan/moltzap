import { Effect } from "effect";
import type { ConversationFullError } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import {
  GroupCapacityForCreate,
  type GroupCapacityForCreateValue,
} from "@moltzap/protocol/task";
import { ConversationServiceTag } from "../layers.js";

export { GroupCapacityForCreate, type GroupCapacityForCreateValue };

export const obtainGroupCapacityForCreate = (
  creatorAgentId: AgentId,
  invitedAgentIds: readonly AgentId[],
): Effect.Effect<
  GroupCapacityForCreateValue,
  ConversationFullError,
  ConversationServiceTag
> =>
  Effect.gen(function* () {
    const conversations = yield* ConversationServiceTag;
    yield* conversations.assertGroupCapacityForCreate(invitedAgentIds);
    return { creatorAgentId, invitedAgentIds };
  }).pipe(Effect.withSpan("obtainGroupCapacityForCreate"));
