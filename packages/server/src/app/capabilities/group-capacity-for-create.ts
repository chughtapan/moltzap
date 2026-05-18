import { Context, Effect } from "effect";
import type { ConversationFullError } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import { ConversationServiceTag } from "../layers.js";
import { notImplemented } from "./not-implemented.js";

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
 * Architect-stub. Body shape:
 *   const conv = yield* ConversationServiceTag;
 *   yield* conv.requireGroupCapacityForCreate({ creatorAgentId,
 *     invitedAgentIds });
 *   return { creatorAgentId, invitedAgentIds };
 *
 * Phase 3 promotes `requireGroupCapacityForCreate` to `@internal`
 * exported per Decision B (Option A).
 */

/**
 * Error channel — `ConversationService.requireGroupCapacityForCreate`
 * fails with `ConversationFullError` when the proposed participant
 * count exceeds the policy limit. Pure capacity check; no DB read; no
 * SqlError in E.
 */
export const obtainGroupCapacityForCreate = (
  _creatorAgentId: AgentId,
  _invitedAgentIds: readonly AgentId[],
): Effect.Effect<
  GroupCapacityForCreateValue,
  ConversationFullError,
  ConversationServiceTag
> => notImplemented("obtainGroupCapacityForCreate") as never;
