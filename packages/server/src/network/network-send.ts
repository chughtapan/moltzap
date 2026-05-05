/**
 * `network.send(to: EndpointAddress, payload: OpaquePayload)
 *   → Effect<DeliveryAck, DeliveryError, never>`
 *
 * The new outbound-routing primitive introduced in Slice G1. Coexists with
 * the legacy {@link Broadcaster} during Phase 8; consumer migration to
 * `network.send` lands in Phase 9 (Slice C). {@link Broadcaster} deletion
 * lands in Phase 10 (Slice G2).
 *
 * Plan: `docs/plans/layered-network-refactor-2026-05.md` §2.4.a, §2.10
 * (Slice G1), §2.11 (resolver constraint). Issue #426 acceptance.
 *
 * Why a tagged service rather than a free function. The send path needs
 * exactly two collaborators — the {@link AgentEndpointResolver} for the
 * agent-kind lookup and the {@link ConnectionManager} for the writable
 * socket — and the dual-DI requirement (issue #426: "New tags introduced
 * alongside") asks for a Tag the rest of the server's `Layer` graph can
 * provide. A class with a single method composed from the two
 * collaborators is the smallest shape that satisfies both.
 *
 * Why the error channel is `never` for the Context parameter. Per Issue
 * #426 acceptance: `Effect<DeliveryAck, DeliveryError, never>`. The
 * service holds its collaborators by direct reference, not Context, so
 * callers do not have to provide additional services to invoke `send`.
 *
 * Endpoint kind handling:
 * - `tm:agent:<connId>` — resolves via the {@link AgentEndpointResolver}'s
 *   reverse index, then writes to the matching connection. O(1) hot path,
 *   no DB lookup (per §2.11). Returns
 *   {@link RecipientNotResolved} if the address is unknown to the
 *   resolver (typical: the recipient connection closed between fan-out
 *   computation and `send` invocation).
 * - `tm:app:<id>` — Phase 9 territory. Returns
 *   {@link EndpointKindNotImplemented}. Slice G1 deliberately does not
 *   ship app-kind delivery to avoid coupling with the TM topology
 *   refactor; that lands as part of Slice C.
 *
 * The brand at `packages/protocol/src/network/actor-model.ts:48` already
 * encodes the kind in the prefix. The send path parses the prefix once
 * and switches; the switch is exhaustive over `EndpointAddressKind`
 * (Phase 6 R3 pattern).
 */
import { Brand, Data, Effect, Match, Option } from "effect";
import {
  endpointAddressKind,
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
      Match.when("agent", () => this.sendToAgentEndpoint(to, payload)),
      Match.when("app", () =>
        Effect.fail(new EndpointKindNotImplemented({ to, kind: "app" })),
      ),
      Match.exhaustive,
    );
  }

  /**
   * Agent-kind delivery. Resolves the address to a live connection via
   * the resolver's reverse index + the connection manager, writes the
   * payload, and tags the outcome.
   *
   * Failure cases:
   * - resolver miss OR resolver hit + closed connection (race):
   *   {@link RecipientNotResolved} — both shapes mean "no live recipient
   *   for this address," and callers cannot tell which without poking
   *   internal state. Folded into one branch.
   * - socket write fails → {@link WriteFailed}.
   */
  private sendToAgentEndpoint(
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
}
