/**
 * Actor-model network types: branded primitives, endpoint registrations, and
 * the authenticated-identity record consumed by the network layer.
 *
 * Wire-layer boundary decoding (UUID format checks etc.) lives at the matching
 * TypeBox primitives in `packages/protocol/src/schema/primitives.ts`. This
 * module is the consumer-facing static type story; runtime exports are
 * limited to nominal-brand factories that pass strings through unchanged.
 *
 * Plan: `docs/plans/layered-network-refactor-2026-05.md` (Slice F).
 *
 * Note: the brand types here intentionally don't appear on the flat-barrel
 * `@moltzap/protocol` entry point. The negative canary at
 * `./actor-model.types-check.ts` and `./actor-model.test.ts` holds that line.
 */
import { Brand } from "effect";
import type { BrandedString } from "../brands.js";

// ---------------------------------------------------------------------------
// Branded primitives
// ---------------------------------------------------------------------------

/** A user identity in the platform — owner of one or more agents. */
export type UserId = BrandedString<"UserId">;
const UserIdBrand = Brand.nominal<UserId>();
/**
 * Brand a raw string as a {@link UserId}. The caller is responsible for the
 * value already being well-formed; wire boundaries decode via the matching
 * TypeBox schema in `packages/protocol/src/schema/primitives.ts`, which
 * checks the UUID format before producing the brand.
 */
export const userId = (value: string): UserId => UserIdBrand(value);

/** An agent identity — the actor that connects, sends messages, and receives. */
export type AgentId = BrandedString<"AgentId">;
const AgentIdBrand = Brand.nominal<AgentId>();
/** Brand a raw string as an {@link AgentId}. See {@link userId} for boundary semantics. */
export const agentId = (value: string): AgentId => AgentIdBrand(value);

/**
 * A reachable address in the actor-model network.
 *
 * Stable across reconnects for registered task-manager endpoints (durable in
 * the `tasks.tm_endpoint_address` column). Volatile per-WS-connection for
 * agent endpoints, where the resolver holds a
 * `HashMap<AgentId, Set<EndpointAddress>>` multimap keyed by agent.
 */
export type EndpointAddress = BrandedString<"EndpointAddress">;
const EndpointAddressBrand = Brand.nominal<EndpointAddress>();
/** Brand a raw string as an {@link EndpointAddress}. */
export const endpointAddress = (value: string): EndpointAddress =>
  EndpointAddressBrand(value);

// ---------------------------------------------------------------------------
// Endpoint kind / registration
// ---------------------------------------------------------------------------

/**
 * The kinds of endpoints the actor-model network resolves.
 *
 * - `"agent"` — a per-WS-connection endpoint resolved by `AgentId` via the
 *   resolver multimap. Volatile.
 * - `"taskManager"` — a registered TM endpoint, durable in the `tasks` row.
 *   Persists across the TM's reconnect window.
 *
 * String-literal union: `switch` over `EndpointKind` is exhaustive at the
 * type level, so adding a third kind here forces every downstream switch to
 * handle it.
 */
export type EndpointKind = "agent" | "taskManager";

/**
 * A registered endpoint as observed by the network layer. Discriminated by
 * {@link EndpointKind}:
 * - `agent` arms carry the resolved {@link AgentId} so the resolver can
 *   key the multimap.
 * - `taskManager` arms carry only the address; ownership of the task is
 *   recorded out-of-band in the `tasks` row.
 */
export type EndpointRegistration =
  | {
      readonly kind: "agent";
      readonly address: EndpointAddress;
      readonly agentId: AgentId;
    }
  | {
      readonly kind: "taskManager";
      readonly address: EndpointAddress;
    };

// ---------------------------------------------------------------------------
// Authenticated identity
// ---------------------------------------------------------------------------

/**
 * The principal behind a connected agent — the post-`auth/connect` view.
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
