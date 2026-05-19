import { Effect } from "effect";
import type { ConversationFullError } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import {
  GroupCapacityForCreate,
  type GroupCapacityForCreateValue,
} from "@moltzap/protocol/task";
import { ConversationServiceTag } from "../layers.js";

export { GroupCapacityForCreate, type GroupCapacityForCreateValue };

/**
 * Smart constructor. Phase 1 promotes
 * `ConversationService.assertGroupCapacityForCreate` to `@internal`
 * exported per Decision B / Option A and narrows its signature to
 * `(pathType, targetAgentIds)` so the obtain helper consumes it
 * without a `mintTask: Effect.never as never` synthesis shim.
 *
 * Error channel propagates `assertGroupCapacityForCreate`'s
 * `ConversationFullError` when the proposed participant count exceeds
 * the policy limit. Pure capacity check; no DB read; no `SqlError` in
 * E.
 */
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
    yield* conversations.assertGroupCapacityForCreate("group", invitedAgentIds);
    return { creatorAgentId, invitedAgentIds };
  }).pipe(Effect.withSpan("obtainGroupCapacityForCreate"));
