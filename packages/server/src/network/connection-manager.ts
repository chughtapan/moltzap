/**
 * Network-layer endpoint registry + agent-endpoint resolver (arch-G).
 *
 * Replaces `packages/server/src/ws/broadcaster.ts` + `packages/server/src/ws/connection.ts`.
 * Every delivery target (agent sockets, task-manager webhooks, in-process
 * task managers) is a `LiveEndpoint` with:
 *   - one `Queue<EventFrame>` sized by the endpoint's `BackpressurePolicy`,
 *   - one scoped fiber that drains the queue into the transport,
 *   - a `Scope` that tears the fiber and the transport down together.
 *
 * `ConnectionManager.register(endpoint)` is the single entry point. Fan-out
 * is not a primitive — `Effect.forEach(participants, (to) => send(to, …))`
 * runs in the caller. The network layer exposes one delivery method:
 * `DeliveryService.send(to, payload)` (module 2).
 *
 * `AgentEndpointResolver` answers `AgentId -> EndpointAddress` for the
 * network layer only. It lives in the network layer per the VP-review
 * clarification on spec #142 (locked).
 *
 * Stub status — architect budget. Every body is `throw new Error(...)`. The
 * implement-* pass fills in the queue wiring, the scoped draining fiber, and
 * the backend-specific transport (WebSocket / webhook / in-process).
 */

import type { Effect, Queue, Scope } from "effect";
// `Ref` and `Option` are only used in type-position (see `LiveEndpoint.failure`);
// imported inline via `import("effect").Ref` / `.Option` to avoid widening the
// value-import surface.
import type { EventFrame } from "@moltzap/protocol/network";
import type { BackpressurePolicy } from "./delivery-service.js";

/* ── Branded identifiers (re-declared locally) ─────────────────────────── */
/*
 * Arch-A's `../app/network-layer.ts` owns the canonical declarations, but
 * the network subtree's TS project boundary (composite: true, rootDir: ".")
 * prevents importing from the parent-project `app/` directory. The brands
 * are structural, so re-declaring here is identity-preserving: a value
 * branded in `app/network-layer.ts` is assignable to the local brand and
 * vice-versa. Implement-* collapses the duplicates when arch-A's
 * `app/network-layer.ts` moves under `src/network/layer.ts`.
 */

export type AgentId = string & { readonly __brand: "AgentId" };
export type EndpointAddress = string & { readonly __brand: "EndpointAddress" };
export type ConnectionId = string & { readonly __brand: "ConnectionId" };

/** Opaque view of a live connection at the network layer — matches arch-A's
 *  `NetworkConnection`. Re-declared for the same rootDir reason. */
export interface NetworkConnection {
  readonly id: ConnectionId;
  readonly agentId: AgentId | null;
  readonly write: (rawFrame: string) => NetworkWriteOutcome;
}

/** Discriminated outcome of a network write. */
export type NetworkWriteOutcome =
  | { readonly _tag: "Written" }
  | { readonly _tag: "BackpressureDropped" }
  | { readonly _tag: "ConnectionClosed" };

/* ── LiveEndpoint ──────────────────────────────────────────────────────── */

/**
 * Endpoint kind — closed union. The network layer does not distinguish
 * task-manager sub-kinds (`default-dm`, `default-group`, `app`); those live
 * in the task-manager registry (arch-C). Here only "agent" vs "task-manager"
 * is visible, matching spec Invariant 3.
 */
export type EndpointKind = "agent" | "task-manager";

/**
 * Transport-agnostic frame sink. The drain fiber calls `send(frame)` for each
 * dequeued frame and the `Transport` is responsible for serialization + I/O
 * (WS `write`, webhook POST, in-process push). Returning a failing Effect
 * tears down the endpoint's scope; the endpoint's teardown handler is called
 * from `Scope.close`.
 *
 * Three concrete `Transport` implementations land in implement-*:
 *   - WS transport — wraps `NetworkConnection.write`.
 *   - Webhook transport — `WebhookClient.call` with retry budget.
 *   - In-process transport — direct `Queue.offer` on the peer's inbox.
 *
 * The `Transport` interface is what makes the endpoint abstraction actually
 * transport-agnostic (flagged by codex review). The drain fiber never branches
 * on `EndpointKind`; it branches on whatever `Transport.send` does.
 */
export interface Transport {
  readonly send: (
    frame: EventFrame,
  ) => Effect.Effect<void, TransportError, never>;
  /** Called by `Scope.close` to release transport resources (close WS, drop
   *  webhook retry budget, etc.). Idempotent. */
  readonly teardown: () => Effect.Effect<void, never, never>;
}

/**
 * Transport I/O failure as seen by the drain fiber. The fiber logs + triggers
 * endpoint teardown; the error surfaces to callers only as
 * `DeliveryTransportFailed` during the brief window before `unregister` runs.
 */
export class TransportError {
  readonly _tag = "TransportError" as const;
  constructor(
    readonly address: EndpointAddress,
    readonly cause: unknown,
  ) {
    throw new Error("not implemented");
  }
}

/**
 * A registered delivery target. One per logical endpoint — an agent's WS
 * connection, a task-manager webhook URL, or an in-process task-manager
 * handle. Created by a transport (e.g. WS upgrade path, webhook registrar)
 * and handed to `ConnectionManager.register`.
 *
 * Ownership: the `scope` is the teardown boundary for both the draining
 * fiber and the underlying transport. `register` forks a drain fiber into
 * this scope; closing the scope interrupts the fiber and calls
 * `transport.teardown`.
 *
 * Failure latch: `failure` is set by the drain fiber when `transport.send`
 * returns a failing Effect; once set, `ConnectionManager.lookup` returns an
 * endpoint whose next `send` short-circuits with `DeliveryTransportFailed`.
 * The drain fiber then closes the scope (triggering `unregister`); subsequent
 * lookups fail with `EndpointNotRegistered`. This is the state backing for
 * `DeliveryTransportFailed` in `delivery-service.ts`.
 */
export interface LiveEndpoint {
  readonly address: EndpointAddress;
  readonly kind: EndpointKind;
  /** Backing connection, if the transport is a WebSocket. Null for webhook
   *  or in-process endpoints. Surfaced so the `NetworkConnectionManager`
   *  read surface (arch-A) can answer connId→conn lookups. */
  readonly connection: NetworkConnection | null;
  /** Transport-agnostic frame sink. Drives the drain fiber. */
  readonly transport: Transport;
  /** Bounded queue. Size and overflow behavior come from `policy`. */
  readonly queue: Queue.Queue<EventFrame>;
  readonly policy: BackpressurePolicy;
  /** Endpoint-owned scope. Closing it tears down the drain fiber + transport. */
  readonly scope: Scope.CloseableScope;
  /** Set by the drain fiber on transport failure. Consulted by `send` before
   *  enqueue so callers get `DeliveryTransportFailed` during the teardown
   *  window. `Ref<Option<TransportError>>` at implement-* time. */
  readonly failure: import("effect").Ref.Ref<
    import("effect").Option.Option<TransportError>
  >;
}

/* ── ConnectionManager service ─────────────────────────────────────────── */

/**
 * Endpoint registry. One entry per registered `EndpointAddress`. The
 * network layer's only write surface — all delivery flows through
 * `DeliveryService.send`, which resolves the address through this manager.
 *
 * This interface is the superset of arch-A's narrowed `NetworkConnectionManager`
 * read surface (`get` / `has` / `size` by `ConnectionId`). Arch-G's impl
 * satisfies both views.
 */
export interface ConnectionManager {
  /**
   * Register a new live endpoint. Forks the scoped drain fiber into
   * `endpoint.scope`. Fails with `EndpointAlreadyRegistered` if the address
   * is already present — registration is not idempotent; re-registration is
   * a caller bug.
   */
  readonly register: (
    endpoint: LiveEndpoint,
  ) => Effect.Effect<void, EndpointAlreadyRegistered, never>;

  /**
   * Unregister an endpoint. Closes the endpoint's scope (tearing down the
   * drain fiber and the transport). Fails with `EndpointNotRegistered` if
   * the address is unknown.
   */
  readonly unregister: (
    address: EndpointAddress,
  ) => Effect.Effect<void, EndpointNotRegistered, never>;

  /**
   * Look up a live endpoint by address. Used by `DeliveryService.send`.
   * Fails with `EndpointNotRegistered` if the address is unknown.
   */
  readonly lookup: (
    address: EndpointAddress,
  ) => Effect.Effect<LiveEndpoint, EndpointNotRegistered, never>;

  /** Snapshot of currently-registered agent endpoints. For presence seeding
   *  and test assertions; not a delivery path. */
  readonly connectedAgents: () => Effect.Effect<
    ReadonlyArray<AgentId>,
    never,
    never
  >;

  /* ── Arch-A read surface (satisfied by the same impl) ───────────────── */

  readonly get: (connId: ConnectionId) => NetworkConnection | undefined;
  readonly has: (connId: ConnectionId) => boolean;
  readonly size: () => number;
}

/** Context tag for {@link ConnectionManager}. */
export declare const ConnectionManagerTag: import("effect").Context.Tag<
  ConnectionManagerTag,
  ConnectionManager
>;
export interface ConnectionManagerTag {
  readonly _: unique symbol;
}

/* ── AgentEndpointResolver service ─────────────────────────────────────── */

/**
 * Maps an `AgentId` to the `EndpointAddress` used for delivery. Owned by
 * the network layer per the VP-review clarification on spec #142
 * ("AgentId → EndpointAddress resolver lives in network layer"). The task
 * layer does not know about endpoint addressing; it hands an `AgentId` to
 * the app-layer fan-out, which resolves via this service and calls
 * `network.send`.
 *
 * Fails with `AgentNotReachable` when the agent has no currently-registered
 * endpoint.
 */
export interface AgentEndpointResolver {
  readonly resolve: (
    agentId: AgentId,
  ) => Effect.Effect<EndpointAddress, AgentNotReachable, never>;
}

/** Context tag for {@link AgentEndpointResolver}. */
export declare const AgentEndpointResolverTag: import("effect").Context.Tag<
  AgentEndpointResolverTag,
  AgentEndpointResolver
>;
export interface AgentEndpointResolverTag {
  readonly _: unique symbol;
}

/* ── Tagged errors ─────────────────────────────────────────────────────── */

/** Re-registration of the same `EndpointAddress`. Caller bug. */
export class EndpointAlreadyRegistered {
  readonly _tag = "EndpointAlreadyRegistered" as const;
  constructor(readonly address: EndpointAddress) {
    throw new Error("not implemented");
  }
}

/** Lookup / unregister for an unknown `EndpointAddress`. */
export class EndpointNotRegistered {
  readonly _tag = "EndpointNotRegistered" as const;
  constructor(readonly address: EndpointAddress) {
    throw new Error("not implemented");
  }
}

/** `resolve(agentId)` found no registered endpoint. Not a delivery error —
 *  the caller decides whether to queue, drop, or defer. */
export class AgentNotReachable {
  readonly _tag = "AgentNotReachable" as const;
  constructor(readonly agentId: AgentId) {
    throw new Error("not implemented");
  }
}

/* ── Not-implemented stub bodies ───────────────────────────────────────── */

/** Opaque forward-reference to `../runtime/layers.ts#LoggerTag`. Re-declared
 *  here for the same rootDir reason as `AgentId` / `EndpointAddress` above:
 *  the network subtree cannot import from the parent-project `runtime/`. The
 *  brands are structural; arch-G's impl satisfies both. Implement-*
 *  collapses the duplicates at the move to `src/network/layer.ts`. */
export interface LoggerTag {
  readonly _: unique symbol;
}

/** Constructor stub — the implement-* pass replaces with a real class +
 *  `Layer.scoped` that wires the internal map and the per-endpoint drain
 *  fibers. Requires `LoggerTag` because the drain fiber logs transport
 *  failures before tearing the endpoint down (see `LiveEndpoint.failure`). */
export declare const makeConnectionManager: () => Effect.Effect<
  ConnectionManager,
  never,
  Scope.Scope | LoggerTag
>;

/** Constructor stub for the resolver. Backed by the registry map from
 *  `ConnectionManager` plus an in-memory agent→address index maintained on
 *  `register` / `unregister`. */
export declare const makeAgentEndpointResolver: (
  cm: ConnectionManager,
) => Effect.Effect<AgentEndpointResolver, never, never>;
