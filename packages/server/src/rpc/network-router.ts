/**
 * Network-layer RPC router.
 *
 * Given a `NetworkRpcMethodRegistry`, produces a dispatcher that reads a
 * `RequestFrame`, resolves the method, validates params, enforces
 * `requiresActive`, runs the handler under `Effect.provide(NetworkLayerLive)
 * .pipe(Effect.provideService(NetworkConnIdTag, connId))`, and maps the
 * exit to a `ResponseFrame`. The provided Layer is the compile-time
 * boundary: any handler whose Effect requires a tag outside
 * `NetworkRequiredContext` cannot be registered.
 *
 * Stub status — signatures only; body is `throw new Error("not implemented")`.
 * The implementer reproduces the mapping already present in the legacy
 * `./router.ts`, specialized to the network Layer and restricted Context.
 */

import type { RequestFrame, ResponseFrame } from "@moltzap/protocol/network";
import type { AuthenticatedContext, NetworkRpcMethodRegistry } from "./network-context.js";
import type { ConnectionId } from "../app/network-layer.js";

/**
 * Dispatch one inbound frame to its registered network handler. Must be
 * invoked only after the caller has populated `ctx` from the connection's
 * authenticated session (except for `auth/connect`, which runs with a
 * synthetic `AuthenticatedContext` and `requiresActive = false`).
 *
 * Error channel — returns a `ResponseFrame` whose `error` field carries a
 * `ParseError | InvalidRequest | MethodNotFound | InvalidParams | Forbidden
 * | Unauthorized | InternalError | <handler-chosen RpcFailure.code>`.
 * No exceptions escape the dispatcher; every failure path produces a
 * response frame.
 */
export type NetworkDispatcher = (
  frame: RequestFrame,
  ctx: AuthenticatedContext,
  connId: ConnectionId,
) => Promise<ResponseFrame>;

/**
 * Build a dispatcher over the given network method registry. Implemented by
 * composing the registered handler Effects with the network Layer and the
 * connection-scoped `NetworkConnIdTag`.
 */
export function createNetworkRpcRouter(
  _methods: NetworkRpcMethodRegistry,
): NetworkDispatcher {
  throw new Error("not implemented");
}
