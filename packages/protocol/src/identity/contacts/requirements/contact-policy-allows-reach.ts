import { RpcMiddleware } from "@effect/rpc";
import { Schema } from "effect";
import { type AgentId, AgentNotFoundError } from "#identity/agents";
import { NotInContactsError } from "../contacts.js";

export interface ContactPolicyAllowsReachValue {
  readonly creatorAgentId: AgentId;
  readonly targetAgentIds: readonly AgentId[];
}

/**
 * Requirement middleware: resolves every target and verifies the creator may
 * reach it under the recipient's contact policy.
 */
export class ContactPolicyAllowsReach extends RpcMiddleware.Tag<ContactPolicyAllowsReach>()(
  "@moltzap/protocol/ContactPolicyAllowsReach",
  { failure: Schema.Union(AgentNotFoundError, NotInContactsError) },
) {}
