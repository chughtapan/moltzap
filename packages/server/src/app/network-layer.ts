/**
 * Network-layer service tags and `NetworkLayerLive` composition.
 *
 * This module is the Effect-Layer embodiment of the network-layer boundary.
 * It exposes exactly four service tags, plus the request-scoped `ConnIdTag`
 * re-exported for symmetry, and composes them into a `Layer` that provides
 * NOTHING task-layer. The router's `Effect.provide(NetworkLayerLive)` is the
 * compile-time enforcement point: a handler that requires a task-layer tag
 * (e.g. `MessageServiceTag`, `AppHostTag`, `ConversationServiceTag`,
 * `DeliveryServiceTag` as currently typed) will fail to compile because
 * `NetworkLayerLive` does not satisfy that requirement.
 *
 * Stub status — `NetworkLayerLive` is declared with its target `ROut`
 * (the four network tags) and `RIn` (the base Db/Logger tier). Its body is
 * a not-implemented stub; the `implement-*` pass wires the four services
 * bottom-up.
 */

import type { Context, Layer } from "effect";

/* ── Narrowed service surfaces ──────────────────────────────────────────── */

/**
 * Network-layer connection registry. The server-wide connection manager is
 * the underlying implementation; the network layer reads through this
 * narrowed surface rather than reaching into the full class.
 */
export interface NetworkConnectionManager {
  readonly get: (connId: ConnectionId) => NetworkConnection | undefined;
  readonly has: (connId: ConnectionId) => boolean;
  readonly size: () => number;
}

/** Branded connection identifier — one per upgraded WebSocket. */
export type ConnectionId = string & { readonly __brand: "ConnectionId" };

/** Opaque view of a live connection at the network layer. */
export interface NetworkConnection {
  readonly id: ConnectionId;
  readonly agentId: AgentId | null;
  readonly write: (rawFrame: string) => NetworkWriteOutcome;
}

/** Branded agent identifier visible to the network layer (routing only). */
export type AgentId = string & { readonly __brand: "AgentId" };

/** Discriminated outcome of a network write. */
export type NetworkWriteOutcome =
  | { readonly _tag: "Written" }
  | { readonly _tag: "BackpressureDropped" }
  | { readonly _tag: "ConnectionClosed" };

/**
 * Narrow delivery surface — `send(to, payload)` is the only primitive the
 * network layer exposes. Payload is opaque; to is a typed endpoint address.
 * This is a deliberate restriction over the existing `DeliveryService`,
 * which carries task-aware helpers.
 */
export interface NetworkDeliveryService {
  readonly send: (
    to: EndpointAddress,
    payload: OpaquePayload,
  ) => Effect<void, NetworkDeliveryError, never>;
}

/** Branded endpoint address — re-declared locally to avoid pulling protocol. */
export type EndpointAddress = string & { readonly __brand: "EndpointAddress" };

/** Branded opaque payload — re-declared locally. */
export type OpaquePayload = string & { readonly __brand: "OpaquePayload" };

/** Discriminated delivery failure surface. */
export type NetworkDeliveryError =
  | { readonly _tag: "EndpointUnknown"; readonly to: EndpointAddress }
  | { readonly _tag: "EndpointOffline"; readonly to: EndpointAddress }
  | { readonly _tag: "BackpressureDropped"; readonly to: EndpointAddress };

/**
 * Network-scope auth surface. Resolves credentials to an `AuthenticatedSession`
 * the router attaches to the connection. The network layer does NOT know
 * anything about user profiles or permissions beyond this.
 */
export interface NetworkAuthService {
  readonly verifyConnect: (
    params: unknown,
  ) => Effect<AuthenticatedSession, NetworkAuthError, never>;
}

/** Authenticated-session bundle — what the router reads into `ctx`. */
export interface AuthenticatedSession {
  readonly agentId: AgentId;
  readonly status: "active" | "pending" | "suspended";
  readonly ownerUserId: UserId | null;
}

/** Branded owner-user identifier. */
export type UserId = string & { readonly __brand: "UserId" };

/** Discriminated auth failure surface. */
export type NetworkAuthError =
  | { readonly _tag: "InvalidCredentials" }
  | { readonly _tag: "AgentNotFound" }
  | { readonly _tag: "AgentSuspended" };

/**
 * Contact-check service — the single task-adjacent capability the network
 * layer is permitted to consult. Required so the network layer can reject
 * delivery to endpoints the sender is not allowed to contact, without
 * importing task-layer modules.
 */
export interface ContactCheckService {
  readonly canContact: (
    from: AgentId,
    to: AgentId,
  ) => Effect<ContactCheckOutcome, never, never>;
}

/** Discriminated contact-check outcome. */
export type ContactCheckOutcome =
  | { readonly _tag: "Allowed" }
  | {
      readonly _tag: "Blocked";
      readonly reason: "not-contact" | "blocked-by-recipient";
    };

/* ── Tags ───────────────────────────────────────────────────────────────── */

/** Tag for {@link NetworkConnectionManager}. */
export declare const NetworkConnectionManagerTag: Context.Tag<
  NetworkConnectionManagerTag,
  NetworkConnectionManager
>;
export interface NetworkConnectionManagerTag {
  readonly _: unique symbol;
}

/** Tag for {@link NetworkDeliveryService}. */
export declare const NetworkDeliveryServiceTag: Context.Tag<
  NetworkDeliveryServiceTag,
  NetworkDeliveryService
>;
export interface NetworkDeliveryServiceTag {
  readonly _: unique symbol;
}

/** Tag for {@link NetworkAuthService}. */
export declare const NetworkAuthServiceTag: Context.Tag<
  NetworkAuthServiceTag,
  NetworkAuthService
>;
export interface NetworkAuthServiceTag {
  readonly _: unique symbol;
}

/** Tag for {@link ContactCheckService}. */
export declare const ContactCheckServiceTag: Context.Tag<
  ContactCheckServiceTag,
  ContactCheckService
>;
export interface ContactCheckServiceTag {
  readonly _: unique symbol;
}

/** Request-scoped connection id tag (re-exported; canonical def in layers.ts). */
export declare const NetworkConnIdTag: Context.Tag<
  NetworkConnIdTag,
  ConnectionId
>;
export interface NetworkConnIdTag {
  readonly _: unique symbol;
}

/* ── Composed Layer ─────────────────────────────────────────────────────── */

/**
 * `NetworkLayerLive` — provides exactly the four network-layer service tags.
 * Requires a base tier (Db, Logger) for implementations to construct
 * themselves. Does NOT provide any task-layer tag.
 *
 * Downstream enforcement — a handler whose Effect requires, say,
 * `MessageServiceTag` will not typecheck under `Effect.provide(NetworkLayerLive)`
 * because `MessageServiceTag` is not in `NetworkLayerOutputs`.
 */
export type NetworkLayerOutputs =
  | NetworkConnectionManagerTag
  | NetworkDeliveryServiceTag
  | NetworkAuthServiceTag
  | ContactCheckServiceTag;

/** Base-tier inputs required by `NetworkLayerLive` (Db, Logger). */
export type NetworkLayerInputs = never;

/** Not implemented — declared stub. */
export declare const NetworkLayerLive: Layer.Layer<
  NetworkLayerOutputs,
  never,
  NetworkLayerInputs
>;

/* ── Effect shorthand (avoids importing `effect` at the arch stage) ─────── */

/**
 * Structural alias for `Effect.Effect<A, E, R>`. The implementer replaces
 * this with the real import; the alias exists so stub signatures below
 * carry the correct three-channel type without `any`.
 */
// prettier-ignore
type Effect<A, E, R> = import("effect").Effect.Effect<A, E, R>;
