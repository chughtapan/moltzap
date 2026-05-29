/**
 * Actor-model network types: the authenticated-identity record consumed
 * by the network layer.
 *
 * Issue #673 cutover: the durable `EndpointAddress` brand + endpoint-kind
 * machinery were deleted. TM authority is now proved via app-ownership
 * of the bound task (`assertAppOwnsTask`); there is no wire-shaped
 * TM-endpoint string left to brand.
 */
import { brandedString, type BrandedString } from "../schema-primitives.js";
import type { UserId, AgentId } from "../identity/methods.js";

/**
 * Server-internal WebSocket connection identifier. Minted at WS accept
 * (`crypto.randomUUID()`); not on the wire. Branded so it cannot be
 * confused with `AgentId`, `AppId`, or other ids in service signatures.
 *
 * Boundary: a single `as ConnectionId` cast at the WS-accept site is the
 * only acceptable construction in production code; downstream is brand-
 * typed end-to-end. Test fixtures use the `connectionId(raw)` constructor
 * exported from `@moltzap/protocol/testing`.
 *
 * Schema-level format: `brandedString` (no UUID predicate). The mint
 * site happens to use UUIDs, but conformance-test fixtures sometimes
 * pass synthetic strings; the brand boundary is the type system, not
 * a format check.
 */
export const ConnectionId = brandedString("ConnectionId");
export type ConnectionId = BrandedString<"ConnectionId">;

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
