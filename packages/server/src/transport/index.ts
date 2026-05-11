/**
 * `transport/` — wire-level dispatch.
 *
 * Owns: WebSocket connection lifecycle, JSON-RPC method binding,
 * per-layer Tag allowlist (type-only hierarchy).
 *
 * Layer rules:
 *   - May import: kernels (db, crypto, runtime, runtime-surface, adapters, config, test-utils, logger).
 *   - May NOT import: identity, network, task, app (those layers compose ON TOP of transport).
 *
 * Public surface:
 *   - `RpcMethodBinding`, `RpcMethodRegistry`, `defineMethod`,
 *     `defineNetworkMethod`, `defineTaskMethod`, `defineAppMethod`,
 *     `AuthenticatedContext`, `DispatchContext`.
 *   - `ConnectionManager`, `MoltZapConnection`, `acquireConnectionRpcClient`,
 *     `sendRpcToClient` (WS lifecycle primitives).
 *   - Type aliases `TransportTags`, `IdentityTags`, `NetworkTags`,
 *     `TaskTags`, `AppTags` (the Tag allowlist hierarchy).
 */

export type {
  AuthenticatedContext,
  DispatchContext,
  RpcMethodBinding,
  RpcMethodRegistry,
} from "./context.js";
export { defineMethod } from "./context.js";
export {
  defineNetworkMethod,
  defineTaskMethod,
  defineAppMethod,
} from "./define-layered-method.js";
export {
  ConnectionManager,
  sendRpcToClient,
  acquireConnectionRpcClient,
} from "./connection.js";
export type { MoltZapConnection } from "./connection.js";
export type {
  TransportTags,
  IdentityTags,
  NetworkTags,
  TaskTags,
  AppTags,
} from "./layer-tags.js";

// Test-only re-export. `unusedJsonRpcClient` is consumed by service tests
// that need a placeholder for the per-connection JsonRpcClient param.
export { unusedJsonRpcClient } from "./connection.test-utils.js";
