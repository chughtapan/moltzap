import { Context } from "effect";
import type { AgentId } from "../../identity/index.js";

/**
 * Tier 3 capability — caller-side contact policy permits creator →
 * targets reach. Single capability covering the family of policy checks
 * (`assertContactPolicyForCreate`, `assertAddParticipantContactPolicy`,
 * `assertCreatorContactsAll`, `checkContactEdge`).
 *
 * Value payload carries the resolved `(creatorAgentId, targetAgentIds)`
 * tuple so service methods don't re-derive who the policy was checked
 * against.
 */
export interface ContactPolicyAllowsReachValue {
  readonly creatorAgentId: AgentId;
  readonly targetAgentIds: readonly AgentId[];
}

export class ContactPolicyAllowsReach extends Context.Tag(
  "@moltzap/protocol/ContactPolicyAllowsReach",
)<ContactPolicyAllowsReach, ContactPolicyAllowsReachValue>() {}
