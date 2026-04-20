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
 * A registered delivery target. One per logical endpoint — an agent's WS
 * connection, a task-manager webhook URL, or an in-process task-manager
 * handle. Created by a transport (e.g. WS upgrade path, webhook registrar)
 * and handed to `ConnectionManager.register`.
 *
 * Ownership: the `scope` is the teardown boundary for both the draining
 * fiber and the underlying transport. `register` forks a drain fiber into
 * this scope; closing the scope interrupts the fiber and closes the
 * transport.
 */
export interface LiveEndpoint {
  readonly address: EndpointAddress;
  readonly kind: EndpointKind;
  /** Backing connection, if the transport is a WebSocket. Null for webhook
   *  or in-process endpoints. Surfaced so the `NetworkConnectionManager`
   *  read surface (arch-A) can answer connId→conn lookups. */
  readonly connection: NetworkConnection | null;
  /** Bounded queue. Size and overflow behavior come from `policy`. */
  readonly queue: Queue.Queue<EventFrame>;
  readonly policy: BackpressurePolicy;
  /** Endpoint-owned scope. Closing it tears down the drain fiber + transport. */
  readonly scope: Scope.CloseableScope;
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

/** Constructor stub — the implement-* pass replaces with a real class +
 *  `Layer.scoped` that wires the internal map and the per-endpoint drain
 *  fibers. */
export declare const makeConnectionManager: () => Effect.Effect<
  ConnectionManager,
  never,
  Scope.Scope
>;

/** Constructor stub for the resolver. Backed by the registry map from
 *  `ConnectionManager` plus an in-memory agent→address index maintained on
 *  `register` / `unregister`. */
export declare const makeAgentEndpointResolver: (
  cm: ConnectionManager,
) => Effect.Effect<AgentEndpointResolver, never, never>;
