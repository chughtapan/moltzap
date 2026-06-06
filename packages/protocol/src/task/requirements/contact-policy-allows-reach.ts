import { Schema } from "effect";
import { RpcMiddleware } from "@effect/rpc";
import type { AgentId } from "../../identity/index.js";
import { NotInContactsError } from "#identity/contacts";

export interface ContactPolicyAllowsReachValue {
  readonly creatorAgentId: AgentId;
  readonly targetAgentIds: readonly AgentId[];
}

/**
 * Requirement middleware: resolves whether the creator may reach every
 * target under the recipients' contact policy. Its `obtain` (server-side) fails
 * with `NotInContactsError`; the descriptor unions that into every method that
 * requires this tag, so the failure is part of the method's typed error
 * channel with no server-side error definition of its own.
 */
export class ContactPolicyAllowsReach extends RpcMiddleware.Tag<ContactPolicyAllowsReach>()(
  "@moltzap/protocol/ContactPolicyAllowsReach",
  { failure: Schema.Union(NotInContactsError) },
) {}
