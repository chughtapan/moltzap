import { Context } from "effect";
import type { AgentId } from "../../identity/index.js";

/**
 * Tier 4 capability — admitting the proposed `invitedAgentIds` to a new
 * task respects policy limits on group capacity. Required by
 * `TaskRequest` ONLY when `invitedAgentIds.length > 1`.
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
  "@moltzap/protocol/GroupCapacityForCreate",
)<GroupCapacityForCreate, GroupCapacityForCreateValue>() {}
