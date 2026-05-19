import { Context, Effect } from "effect";
import type { ConversationFullError } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import { ConversationServiceTag } from "../layers.js";

/**
 * Tier 4 capability — admitting the proposed `invitedAgentIds` to a new
 * task respects policy limits on group capacity. Required by
 * `TaskCreate` ONLY when `invitedAgentIds.length > 1`.
 *
 * Value payload carries `(creatorAgentId, invitedAgentIds)` to match
 * the obtain-time argument set; service methods consuming the capability
 * verify the count matches handler input.
 */
export interface GroupCapacityForCreateValue {
  readonly creatorAgentId: AgentId;
  readonly invitedAgentIds: readonly AgentId[];
}

export class GroupCapacityForCreate extends Context.Tag(
  "@moltzap/server/GroupCapacityForCreate",
)<GroupCapacityForCreate, GroupCapacityForCreateValue>() {}

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
