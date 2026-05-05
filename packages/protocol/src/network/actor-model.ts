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

/**
 * Endpoint kinds that may appear at the address prefix. Extending this list
 * is the single edit point for new endpoint kinds.
 *
 * Phase 9 (plan §2.4.a + Phase 8 codex deferral): `agent` carries the
 * durable agent-id form `tm:agent:<agentId>` minted by
 * {@link makeEndpointAddress} for task-manager registration (column
 * `tasks.tm_endpoint_address`). `agent-conn` carries the volatile
 * per-WebSocket-connection form `tm:agent-conn:<connId>` used by
 * `AgentEndpointResolver` to address one specific connection of an
 * authenticated agent. `app` is reserved for app-TM registrations the
 * Phase-9 topology dispatches via in-process loopback or real WS.
 *
 * The split exists because routing semantics differ — `agent` resolves
 * to "any connection of agentId" via the resolver's forward map, while
 * `agent-conn` resolves to exactly one connection via the reverse
 * index. Without distinct kinds, durable TM-routed `network.send`
 * collapses into the per-connection reverse lookup and silently fails
 * with `RecipientNotResolved` for any address whose tail is an agent id
 * rather than a connection id.
 *
 * Order matters: the longer prefix `agent-conn:` MUST appear before
 * `agent:` in the loops below so `startsWith("agent:")` does not
 * pre-empt the `agent-conn` match. The const tuple's declaration order
 * is the sole source of truth for that ordering.
 */
export const ENDPOINT_ADDRESS_KINDS = ["agent-conn", "agent", "app"] as const;
export type EndpointAddressKind = (typeof ENDPOINT_ADDRESS_KINDS)[number];

/**
 * Common prefix for every {@link EndpointAddress} on the wire — `tm:`.
 * Exported so server-side code that mints addresses or routes by kind
 * does not re-declare the same string and silently fork.
 */
export const ENDPOINT_ADDRESS_PREFIX = "tm:";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Predicate that an endpoint address has the canonical wire shape:
 *  `tm:<kind>:<uuid>`. Exported for tests and reviewers. */
export const isEndpointAddress = (value: unknown): value is EndpointAddress => {
  if (typeof value !== "string") return false;
  if (!value.startsWith(ENDPOINT_ADDRESS_PREFIX)) return false;
  const rest = value.slice(ENDPOINT_ADDRESS_PREFIX.length);
  // Walk in declaration order so `agent-conn:` is tried before `agent:`.
  // See ENDPOINT_ADDRESS_KINDS doc for the longest-prefix invariant.
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
 * shape `tm:<kind>:<uuid>` with `kind ∈ {@link ENDPOINT_ADDRESS_KINDS}`.
 * This helper checks the kinds in declaration order and returns the
 * first match. Adding a new kind to the const tuple automatically
 * extends this dispatch as long as the brand predicate is updated in
 * lockstep — the {@link ENDPOINT_ADDRESS_KINDS}-driven loop owns the
 * exhaustiveness story.
 *
 * The trailing `return ENDPOINT_ADDRESS_KINDS[0]` is unreachable for any
 * well-formed branded value (the brand guarantees at least one match)
 * but appears for the type checker — `for...of` does not narrow to a
 * non-empty result. The brand's own tests cover the malformed case.
 */
export const endpointAddressKind = (
  address: EndpointAddress,
): EndpointAddressKind => {
  const raw = address as string;
  const rest = raw.slice(ENDPOINT_ADDRESS_PREFIX.length);
  // Walk in declaration order — `agent-conn:` must precede `agent:` so
  // the longer prefix wins (a `tm:agent-conn:<uuid>` value would also
  // satisfy `startsWith("agent:")` if `agent` came first, which would
  // mis-classify the kind).
  for (const kind of ENDPOINT_ADDRESS_KINDS) {
    if (rest.startsWith(`${kind}:`)) return kind;
  }
  return ENDPOINT_ADDRESS_KINDS[0];
};

/**
 * Mint an `EndpointAddress` from a kind and a UUID. The single
 * construction site for `tm:<kind>:<uuid>` strings — every other
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
 * {@link EndpointAddressKind}. `EndpointAddressKind` (`"agent-conn"`,
 * `"agent"`, `"app"`) parses the wire-format `tm:<kind>:<uuid>` string;
 * `EndpointKind` here labels a registration record's discriminator.
 *
 * - `"agent"` — a registered agent-identity endpoint. The resolver
 *   multimap keys by `AgentId`; the matching wire address kinds are
 *   `agent-conn` (volatile per-WS) and `agent` (durable per-agent).
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
