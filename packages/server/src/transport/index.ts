/**
 * `transport/` — wire-level dispatch.
 *
 * Owns: WebSocket connection lifecycle (`transport/connection.ts`), JSON-RPC method
 * binding (`transport/define-layered-method.ts`, `transport/context.ts`, `transport/layer-scopes.ts`),
 * boundary-types check.
 *
 * Layer rules:
 *   - May import: kernels (db, crypto, runtime, runtime-surface, adapters, config, test-utils, logger).
 *   - May NOT import: identity, network, task, app (those layers compose ON TOP of transport).
 *
 * Public surface: `RpcMethodBinding`, `RpcMethodRegistry`, `defineMethod`,
 * `defineNetworkMethod`, `defineTaskMethod`, `defineAppMethod`,
 * `AuthenticatedContext`, `DispatchContext`, `LayerScope` tags.
 *
 * Populated in 2A.2 (folder moves). Empty in 2A.1.
 */
export {};
