import { RpcMiddleware } from "@effect/rpc";
import { Schema } from "effect";
import { AgentNotFoundError, type AgentId } from "#identity/agents";
import { NotInContactsError } from "../contacts.js";

/** Describes contact policy allows reach value. */
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
