/**
 * Actor-model network types: the authenticated-identity record consumed
 * by the network layer.
 *
 * Issue #673 cutover: the durable `EndpointAddress` brand + endpoint-kind
 * machinery were deleted. TM authority is now proved via app-ownership
 * of the calling WS connection (see `AppHost.isAppConnection`); there is
 * no wire-shaped TM-endpoint string left to brand.
 */
import type { UserId, AgentId } from "../identity/methods.js";

/**
 * The principal behind a connected agent — the post-`network/connect` view.
 *
 * Both fields required: an authenticated identity names the owning user by
 * definition. The wire-layer `AgentSchema.ownerUserId` is `Optional` to
 * accommodate the un-claimed `pending_claim` storage state; the actor-model
 * layer only sees identities that have already passed authentication, so the
 * optionality is collapsed here.
 */
export type AuthenticatedIdentity = {
  readonly agentId: AgentId;
  readonly userId: UserId;
};
