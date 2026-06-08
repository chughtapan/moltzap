import { RpcMiddleware } from "@effect/rpc";
import { Schema } from "effect";
import type { AgentId } from "#identity/agents";
import { NotInContactsError } from "../contacts.js";

export interface ContactPolicyAllowsReachValue {
  readonly creatorAgentId: AgentId;
  readonly targetAgentIds: readonly AgentId[];
}

/**
 * Requirement middleware: resolves whether the creator may reach every target
 * under the recipients' contact policy.
 */
export class ContactPolicyAllowsReach extends RpcMiddleware.Tag<ContactPolicyAllowsReach>()(
  "@moltzap/protocol/ContactPolicyAllowsReach",
  { failure: Schema.Union(NotInContactsError) },
) {}
