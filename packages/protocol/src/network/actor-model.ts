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
 * `EndpointAddress` is a nominal `BrandedString` carrying the wire shape
 * `tm:&lt;kind>:&lt;uuid>`; the brand factory and predicate enforce the shape at
 * mint time. Re-exported from `network/index.ts` and (via `export *`) from
 * the root `@moltzap/protocol` flat barrel.
 */
import { Brand } from "effect";
import type { BrandedString } from "../schema-primitives.js";
import type { UserId, AgentId } from "../identity/methods.js";

/**
 * A reachable address in the actor-model network.
 *
 * Stable across reconnects for registered task-manager endpoints (durable in
 * the `tasks.tm_endpoint_address` column).
 *
 * Phase 9b consumer-migration (sub-issue #460 amendment): `EndpointAddress`
 * is durable-only. Per-connection routing uses `ConnectionId` directly
 * inside `AgentEndpointResolver`'s reverse index — the `agent-conn` kind
 * that previously wrapped `connId` as an `EndpointAddress` was internal
 * leakage (never appeared on the wire, never appeared in any DB column,
 * never accepted from any client) and has been removed.
 */
export type EndpointAddress = BrandedString<"EndpointAddress">;

/**
 * Endpoint kinds that may appear at the address prefix. Extending this list
 * is the single edit point for new endpoint kinds.
 *
 * Phase 9b consumer-migration (sub-issue #460 amendment): the
 * `agent-conn` kind retired. The volatile per-WebSocket-connection
 * lookup primitive lives entirely inside `AgentEndpointResolver` keyed
 * by `ConnectionId`; nothing on the wire serializes it. `agent` carries
 * the durable agent-id form `tm:agent:&lt;agentId>` minted by
 * {@link makeEndpointAddress} for task-manager registration (column
 * `tasks.tm_endpoint_address`). `app` is reserved for app-TM
 * registrations the Phase-9 topology dispatches via in-process loopback
 * or real WS.
 */
const ENDPOINT_ADDRESS_KINDS = ["agent", "app"] as const;
export type EndpointAddressKind = (typeof ENDPOINT_ADDRESS_KINDS)[number];

/**
 * Common prefix for every {@link EndpointAddress} on the wire — `tm:`.
 * Exported so server-side code that mints addresses or routes by kind
 * does not re-declare the same string and silently fork.
 */
const ENDPOINT_ADDRESS_PREFIX = "tm:";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Predicate that an endpoint address has the canonical wire shape
 * `tm:&lt;kind&gt;:&lt;uuid&gt;`. Exported for tests and reviewers.
 */
export const isEndpointAddress = (value: unknown): value is EndpointAddress => {
  if (typeof value !== "string") return false;
  if (!value.startsWith(ENDPOINT_ADDRESS_PREFIX)) return false;
  const rest = value.slice(ENDPOINT_ADDRESS_PREFIX.length);
  for (const kind of ENDPOINT_ADDRESS_KINDS) {
    const kindPrefix = `${kind}:`;
    if (rest.startsWith(kindPrefix)) {
      return UUID_PATTERN.test(rest.slice(kindPrefix.length));
    }
  }
  return false;
};

const EndpointAddressBrand = Brand.refined<EndpointAddress>(
  isEndpointAddress,
  (value) =>
    Brand.error(
      `Invalid EndpointAddress: expected "tm:<kind>:<uuid>" with kind ∈ {${ENDPOINT_ADDRESS_KINDS.join(", ")}}, got ${JSON.stringify(value)}`,
    ),
);
/** Brand a raw string as an {@link EndpointAddress}. Throws if the value
 *  fails {@link isEndpointAddress}. */
export const endpointAddress = (value: string): EndpointAddress =>
  EndpointAddressBrand(value);

/**
 * Read the `kind` segment out of a branded {@link EndpointAddress}.
 *
 * The brand predicate at {@link isEndpointAddress} already proves the
 * shape `tm:&lt;kind>:&lt;uuid>` with `kind ∈ {@link ENDPOINT_ADDRESS_KINDS}`.
 * This helper checks the kinds in declaration order and returns the
 * first match. Adding a new kind to the const tuple automatically
 * extends this dispatch as long as the brand predicate is updated in
 * lockstep — the {@link ENDPOINT_ADDRESS_KINDS}-driven loop owns the
 * exhaustiveness story.
 *
 * The post-loop path is unreachable for any well-formed branded value;
 * it throws rather than silently returning a default (Principle 4).
 */
export const endpointAddressKind = (
  address: EndpointAddress,
): EndpointAddressKind => {
  const raw = address as string;
  const rest = raw.slice(ENDPOINT_ADDRESS_PREFIX.length);
  for (const kind of ENDPOINT_ADDRESS_KINDS) {
    if (rest.startsWith(`${kind}:`)) return kind;
  }
  return absurd(raw as never);
};

/**
 * Mint an `EndpointAddress` from a kind and a UUID. The single
 * construction site for `tm:&lt;kind>:&lt;uuid>` strings — every other
 * caller routes through here so the wire format does not fork.
 *
 * Throws if the resulting string fails {@link isEndpointAddress} (e.g.,
 * `uuid` is not a UUID).
 */
export const makeEndpointAddress = (
  kind: EndpointAddressKind,
  uuid: string,
): EndpointAddress =>
  endpointAddress(`${ENDPOINT_ADDRESS_PREFIX}${kind}:${uuid}`);

// ---------------------------------------------------------------------------
// Endpoint kind / registration
// ---------------------------------------------------------------------------

/**
 * The kinds of endpoints the actor-model network resolves.
 *
 * Disambiguation: this is the legacy registration-tag union used by
 * {@link EndpointRegistration}, NOT the address-prefix-driven
 * {@link EndpointAddressKind}. `EndpointAddressKind` (`"agent"`, `"app"`)
 * parses the wire-format `tm:&lt;kind>:&lt;uuid>` string; `EndpointKind` here
 * labels a registration record's discriminator.
 *
 * - `"agent"` — a registered agent-identity endpoint. The resolver
 *   multimap keys by `AgentId`; the matching wire address kind is
 *   `agent` (durable per-agent). Per-connection routing is internal to
 *   the resolver and uses `ConnectionId` directly.
 * - `"taskManager"` — a registered TM endpoint, durable in the `tasks`
 *   row. Persists across the TM's reconnect window.
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

// ---------------------------------------------------------------------------
// Exhaustiveness helpers (Principle 4)
// ---------------------------------------------------------------------------

/** Exhaustiveness sentinel — throws at runtime if a branch believed
 *  unreachable is ever reached (e.g. a branded-value invariant breaks). */
function absurd(x: never): never {
  throw new Error(`unreachable: ${JSON.stringify(x)}`);
}
