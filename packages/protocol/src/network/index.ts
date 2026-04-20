/**
 * `@moltzap/protocol/network` — network-layer public surface.
 *
 * This entry point carries ONLY types/constants that belong to the network
 * layer: wire frames, transport error codes, the auth/connect handshake,
 * system-level methods (heartbeat/ping), and the endpoint-address / opaque-
 * payload primitives. Task-layer schemas (messages, conversations, contacts,
 * invites, apps, surfaces, presence semantics) live in `@moltzap/protocol/task`
 * and are not reachable from this entry point.
 *
 * Invariant — the type graph reachable from this file MUST NOT contain any
 * type re-exported from `../task/index.ts`. An ESLint rule enforces this at
 * source level; this comment is the human-readable statement of the contract.
 *
 * Stub status — every export below is a named declaration an `implement-*`
 * pass will fill in. The names, not the bodies, are the architectural
 * contract for downstream slices.
 */

import type { TSchema } from "../rpc.js";

/**
 * Re-export TypeBox / RpcDefinition helpers so network-layer call sites
 * (router, handler binder) can import them from `@moltzap/protocol/network`
 * without reaching into the task-layer entry point.
 */
export type { RpcDefinition, Static, TSchema } from "../rpc.js";

/* ── Wire frames ────────────────────────────────────────────────────────── */

/** JSON-RPC request frame on the wire. Populated by implementer. */
export type RequestFrame = never;

/** JSON-RPC response frame on the wire. Populated by implementer. */
export type ResponseFrame = never;

/** Server-pushed event frame. Populated by implementer. */
export type EventFrame = never;

/* ── Wire error channel ─────────────────────────────────────────────────── */

/** Numeric wire-level error code discriminator. Populated by implementer. */
export type ErrorCode = never;

/**
 * Wire-level error code table. Values defined by implementer; the set is
 * fixed at the network layer and is NOT extended by task-layer code.
 */
export declare const ErrorCodes: Readonly<Record<string, number>>;

/** Wire shape of the `error` field on a `ResponseFrame`. */
export type RpcError = { readonly code: number; readonly message: string; readonly data?: unknown };

/* ── Network primitives — endpoint + opaque payload ─────────────────────── */

/**
 * Branded identifier for a network-addressable endpoint (an agent, a session
 * participant, a session). Decoded at the network boundary; passed opaquely
 * by the task layer. Never parsed at the network layer beyond schema check.
 */
export type EndpointAddress = string & { readonly __brand: "EndpointAddress" };

/**
 * Opaque payload bytes carried end-to-end by the network layer. The network
 * layer MUST NOT decode, validate, or inspect `OpaquePayload` — only route it.
 */
export type OpaquePayload = string & { readonly __brand: "OpaquePayload" };

/* ── Network RPC method manifests ───────────────────────────────────────── */

/**
 * Auth handshake — the only RPC method an unauthenticated connection may
 * invoke. Its manifest exposes params/result schemas for AJV compilation.
 */
export declare const AuthConnect: {
  readonly name: "auth/connect";
  readonly paramsSchema: TSchema;
  readonly resultSchema: TSchema;
  readonly validateParams: (data: unknown) => boolean;
};

/** System ping. Owned by the network layer. */
export declare const SystemPing: {
  readonly name: "system/ping";
  readonly paramsSchema: TSchema;
  readonly resultSchema: TSchema;
  readonly validateParams: (data: unknown) => boolean;
};

/* ── Wire validators ────────────────────────────────────────────────────── */

/**
 * Pre-compiled AJV validators for wire-frame shapes. Task-layer param
 * validators are NOT re-exported here; they live behind `@moltzap/protocol/task`.
 */
export declare const networkValidators: {
  readonly requestFrame: (data: unknown) => boolean;
  readonly responseFrame: (data: unknown) => boolean;
  readonly eventFrame: (data: unknown) => boolean;
  readonly authConnectParams: (data: unknown) => boolean;
  readonly systemPingParams: (data: unknown) => boolean;
};

/* ── Protocol version ───────────────────────────────────────────────────── */

/** Wire protocol version string. Populated by implementer. */
export declare const PROTOCOL_VERSION: string;
