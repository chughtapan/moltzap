/**
 * `network.send(to: EndpointAddress, payload: OpaquePayload)
 *   → Effect<DeliveryAck, DeliveryError, never>`
 *
 * The outbound-routing primitive introduced in Slice G1 and extended in
 * Phase 9 (Slice C) with durable-agent + app-TM routing. Coexists with
 * the legacy {@link Broadcaster} until {@link Broadcaster} deletion in
 * Phase 10 (Slice G2).
 *
 * Plan: `docs/plans/layered-network-refactor-2026-05.md` §1.3 in-process
 * loopback policy, §2.4.a `messages/send` TM routing, §2.10 (Slice G1),
 * §2.11 (resolver constraint). Issue #426 acceptance + #427 acceptance
 * (Phase 8 codex deferral on namespace split).
 *
 * Why a tagged service rather than a free function. The send path needs
 * exactly two collaborators — the {@link AgentEndpointResolver} for both
 * volatile (`agent-conn`) and durable (`agent`) lookups, and the
 * {@link ConnectionManager} for the writable socket. The dual-DI
 * requirement asks for a Tag the rest of the server's `Layer` graph can
 * provide. A class with a single method composed from both collaborators
 * is the smallest shape that satisfies both.
 *
 * Why the error channel is `never` for the Context parameter. The service
 * holds its collaborators by direct reference, not Context, so callers do
 * not have to provide additional services to invoke `send`.
 *
 * Endpoint kind handling (post Phase 9 namespace split):
 * - `tm:agent-conn:<connId>` — volatile per-WebSocket-connection address.
 *   Resolves via the {@link AgentEndpointResolver}'s reverse index, then
 *   writes to the matching connection. O(1) hot path, no DB lookup (per
 *   §2.11). {@link RecipientNotResolved} on miss.
 * - `tm:agent:<agentId>` — durable agent-id form, used for task-manager
 *   registration in `tasks.tm_endpoint_address`. Resolves via the
 *   resolver's forward map (`resolveAll`) and writes to one of the
 *   agent's live connections. {@link RecipientNotResolved} when the
 *   agent has no live connection. Plan §1.3 in-process loopback policy:
 *   the same code path always runs, even when the durable address
 *   resolves to a connection in the same process.
 * - `tm:app:<id>` — app-TM registrations resolved via the resolver
 *   (apps register an endpoint address; the address routes through the
 *   same connection table as agent kinds). {@link EndpointKindNotImplemented}
 *   when the app-TM is not registered through the standard
 *   resolver-backed path; consumers that want app-TM dispatch wire
 *   the resolver registration at app start.
 *
 * The brand at `packages/protocol/src/network/actor-model.ts` already
 * encodes the kind in the prefix. The send path parses the prefix once
 * and switches; the switch is exhaustive over `EndpointAddressKind`
 * (Phase 6 R3 pattern).
 */
import { Brand, Data, Effect, HashSet, Match, Option } from "effect";
import {
  agentId as makeAgentId,
  endpointAddressKind,
  type AgentId,
  type EndpointAddress,
  type EndpointAddressKind,
} from "@moltzap/protocol/network";
import type * as Socket from "@effect/platform/Socket";
import { ConnectionManager } from "../ws/connection.js";
import { AgentEndpointResolver } from "./agent-endpoint-resolver.js";

/**
 * Branded raw-string payload. Opaque to the network: `network.send`
 * does not parse, transform, or validate the payload — it writes the
 * exact bytes to the recipient socket.
 *
 * Why opaque. The send primitive sits below the typed-RPC layer (which
 * encodes/decodes JSON-RPC frames). Callers serialize a frame to a string
 * (or any wire-encodable bytes-as-string) before crossing the boundary.
 * The brand prevents an unwitting caller from passing an arbitrary
 * `string` (e.g., a plain message body) where a wire frame is expected.
 *
 * Construction site: {@link opaquePayload}. The brand is nominal — there
 * is no shape predicate — because the only invariant `network.send` cares
 * about is "the caller intends this to be a wire-ready payload."
 */
export type OpaquePayload = string & Brand.Brand<"OpaquePayload">;
const OpaquePayloadBrand = Brand.nominal<OpaquePayload>();

/** Brand a raw string as an {@link OpaquePayload}. */
export const opaquePayload = (raw: string): OpaquePayload =>
  OpaquePayloadBrand(raw);

// ---------------------------------------------------------------------------
// Result + error channel
// ---------------------------------------------------------------------------

/**
 * Acknowledges a successful write to the underlying socket.
 *
 * Carries the recipient address; no count field — Slice G1 only routes
 * single-recipient agent addresses, so a count would always be 1. When
 * Slice G2 (Phase 10) introduces multi-recipient sends, the right shape
 * is a list of delivered addresses, not a counter — added then with the
 * concrete need.
 */
export class DeliveryAck extends Data.TaggedClass("DeliveryAck")<{
  readonly to: EndpointAddress;
}> {}

/**
 * The recipient address has no live connection. Typical cause: the
 * recipient socket closed between resolver lookup and the `send` call.
 * Caller-recoverable — the right response is usually to drop or queue,
 * not retry.
 */
export class RecipientNotResolved extends Data.TaggedError(
  "RecipientNotResolved",
)<{
  readonly to: EndpointAddress;
}> {}

/**
 * The address is well-formed but its kind is not yet wired in this slice.
 * Specifically: `tm:app:` addresses are reserved for Phase 9 (Slice C).
 *
 * Distinguished from {@link RecipientNotResolved} because the failure is
 * a build-time gap (this slice does not ship the implementation), not a
 * runtime liveness gap (the recipient is gone). Caller observability
 * benefits from the distinction; once Phase 9 lands, this tag is removed
 * from the channel.
 */
export class EndpointKindNotImplemented extends Data.TaggedError(
  "EndpointKindNotImplemented",
)<{
  readonly to: EndpointAddress;
  readonly kind: EndpointAddressKind;
}> {}

/**
 * The underlying socket write failed. Wraps the inner
 * {@link Socket.SocketError} so the caller can distinguish a write
 * failure from a resolution failure without re-running the lookup.
 *
 * Per the Phase 1B platform decision, the wire is `@effect/platform`
 * Socket; the cause type comes from there.
 */
export class WriteFailed extends Data.TaggedError("WriteFailed")<{
  readonly to: EndpointAddress;
  readonly cause: Socket.SocketError;
}> {}

/**
 * Discriminated union of every failure mode `network.send` can produce.
 * Exhaustive at the call site via `_tag` matching (Phase 6 R3 pattern).
 */
export type DeliveryError =
  | RecipientNotResolved
  | EndpointKindNotImplemented
  | WriteFailed;

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * The outbound-routing primitive. Use the constructor directly in code;
 * route through `NetworkSendServiceTag` in DI-aware code.
 */
export class NetworkSendService {
  constructor(
    private readonly resolver: AgentEndpointResolver,
    private readonly connections: ConnectionManager,
  ) {}

  /**
   * Route `payload` to the connection bound to `to`. Resolves the address
   * kind once, dispatches per kind, and returns a {@link DeliveryAck} on
   * success or a {@link DeliveryError} member on failure.
   *
   * The Effect's R parameter is `never`: the service holds its
   * collaborators directly, so callers do not have to provide a
   * {@link AgentEndpointResolver} / {@link ConnectionManager} via Context
   * to invoke `send`.
   */
  send(
    to: EndpointAddress,
    payload: OpaquePayload,
  ): Effect.Effect<DeliveryAck, DeliveryError, never> {
    const kind: EndpointAddressKind = endpointAddressKind(to);
    return Match.value(kind).pipe(
      Match.when("agent-conn", () => this.sendToAgentConnection(to, payload)),
      Match.when("agent", () => this.sendToDurableAgent(to, payload)),
      Match.when("app", () =>
        Effect.fail(new EndpointKindNotImplemented({ to, kind: "app" })),
      ),
      Match.exhaustive,
    );
  }

  /**
   * Volatile per-connection delivery. Resolves the address to a live
   * connection via the resolver's reverse index + the connection
   * manager, writes the payload, and tags the outcome.
   *
   * Failure cases:
   * - resolver miss OR resolver hit + closed connection (race):
   *   {@link RecipientNotResolved} — both shapes mean "no live recipient
   *   for this address," and callers cannot tell which without poking
   *   internal state. Folded into one branch.
   * - socket write fails → {@link WriteFailed}.
   */
  private sendToAgentConnection(
    to: EndpointAddress,
    payload: OpaquePayload,
  ): Effect.Effect<DeliveryAck, DeliveryError, never> {
    return Effect.gen(this, function* () {
      const connOpt = Option.flatMap(
        yield* this.resolver.connectionForAddress(to),
        (id) => Option.fromNullable(this.connections.get(id)),
      );
      if (Option.isNone(connOpt)) {
        return yield* Effect.fail(new RecipientNotResolved({ to }));
      }
      yield* connOpt.value
        .write(payload)
        .pipe(Effect.mapError((cause) => new WriteFailed({ to, cause })));
      return new DeliveryAck({ to });
    });
  }

  /**
   * Durable-agent delivery. Phase 9 (plan §2.4.a): the
   * `tm:agent:<agentId>` form is what task-manager registration writes
   * into `tasks.tm_endpoint_address`. The address survives reconnects;
   * resolution happens at send time via the resolver's forward map
   * (`resolveAll`).
   *
   * Routing semantics:
   * - The resolver's forward set carries the agent's volatile
   *   `tm:agent-conn:<connId>` addresses (one per live connection).
   *   `sendToDurableAgent` picks one and writes to it. The arbitrary
   *   choice mirrors `Broadcaster.sendToAgent` today (also picks one
   *   live connection from the per-agent list); plan §2.4.a does not
   *   pin a per-connection policy.
   * - `RecipientNotResolved` when the agent has no live connection —
   *   the durable address persists in the column but no socket holds
   *   it right now. Caller-recoverable; the right response is usually
   *   to drop or queue, not retry.
   *
   * Plan §1.3 in-process loopback policy: the same code path runs
   * regardless of whether the resolved connection is in this process.
   * No short-circuit, no separate fast-path. One code path.
   */
  private sendToDurableAgent(
    to: EndpointAddress,
    payload: OpaquePayload,
  ): Effect.Effect<DeliveryAck, DeliveryError, never> {
    return Effect.gen(this, function* () {
      const agentIdValue = parseAgentIdFromDurableAddress(to);
      const conns = yield* this.resolver.resolveAll(agentIdValue);
      // Pick-one fan-out: TM is one logical entity per agent;
      // multi-connection devices receive the same TM-routed dispatch
      // only once. Confirmed via #459 review thread.
      const firstAddr = Option.fromIterable(HashSet.values(conns));
      if (Option.isNone(firstAddr)) {
        return yield* Effect.fail(new RecipientNotResolved({ to }));
      }
      const connId = yield* this.resolver.connectionForAddress(firstAddr.value);
      const connOpt = Option.flatMap(connId, (id) =>
        Option.fromNullable(this.connections.get(id)),
      );
      if (Option.isNone(connOpt)) {
        return yield* Effect.fail(new RecipientNotResolved({ to }));
      }
      yield* connOpt.value
        .write(payload)
        .pipe(Effect.mapError((cause) => new WriteFailed({ to, cause })));
      return new DeliveryAck({ to });
    });
  }
}

/**
 * Strip the `tm:agent:` prefix from an EndpointAddress whose kind has
 * already been confirmed to be `agent` (durable form). The brand
 * predicate at the protocol layer rejects non-UUID inputs, so the only
 * branch that fires here is the well-formed durable address — the
 * {@link EndpointAddress} brand on the input already enforces shape.
 */
const DURABLE_AGENT_PREFIX = "tm:agent:";

function parseAgentIdFromDurableAddress(address: EndpointAddress): AgentId {
  // EndpointAddress is a branded string. Drop the brand structurally
  // via String(...) so the slice operates on a plain string.
  const raw = String(address);
  return makeAgentId(raw.slice(DURABLE_AGENT_PREFIX.length));
}
