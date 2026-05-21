import { Context } from "effect";
import type { AgentId } from "../../identity/index.js";

export interface ContactPolicyAllowsReachValue {
  readonly creatorAgentId: AgentId;
  readonly targetAgentIds: readonly AgentId[];
}

export class ContactPolicyAllowsReach extends Context.Tag(
  "@moltzap/protocol/ContactPolicyAllowsReach",
)<ContactPolicyAllowsReach, ContactPolicyAllowsReachValue>() {}
