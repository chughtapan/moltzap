import { Context } from "effect";
import type { AgentId } from "../../identity/index.js";
import { NotInContactsError } from "../../identity/contacts.js";

export interface ContactPolicyAllowsReachValue {
  readonly creatorAgentId: AgentId;
  readonly targetAgentIds: readonly AgentId[];
}

/**
 * Capability-as-middleware: resolves whether the creator may reach every
 * target under the recipients' contact policy. Its `obtain` (server-side) fails
 * with `NotInContactsError`; the descriptor unions that into every method that
 * requires this cap, so the failure is part of the method's typed error channel
 * with no server-side error definition of its own.
 */
export class ContactPolicyAllowsReach extends Context.Tag(
  "@moltzap/protocol/ContactPolicyAllowsReach",
)<ContactPolicyAllowsReach, ContactPolicyAllowsReachValue>() {
  static get errors() {
    return [NotInContactsError] as const;
  }
}
