/**
 * @file Transport layer public barrel.
 *
 * The transport layer owns WebSocket connection lifecycle, JSON-RPC method
 * binding, and the type-only per-layer Tag allowlist hierarchy. It may import
 * kernels only; identity, network, task, and app compose on top of transport.
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
