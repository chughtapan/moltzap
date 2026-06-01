/**
 * @file The per-connection runtime for the protocol-owned `PrincipalResolution`
 * middleware + the request-scoped `ConnectionTag`.
 *
 * `makePrincipalResolutionLayer(connId, principalKinds)` is constructed ONLY by
 * the socket-open path inside that connection's `Scope`, closing over its
 * `ConnectionId`. It is NEVER app-memoized or shared: a shared instance would
 * collide every connection on the constant `MUX_CLIENT_ID` and resolve the wrong
 * principal — cross-connection principal cross-talk. On each request the gate
 * reads the LIVE arm by the closed-over `connId` (peeked off the shared
 * `ConnectionManager`); `clientId` is ignored (constant per mux). It runs the
 * #720 gate (the `principalKinds` policy keyed by `rpc._tag`) and provides the
 * narrowed `CurrentPrincipal`; `ConnectionTag` carries the unnarrowed 3-arm
 * `Connection` for the unauth `network/connect` path.
 *
 * The factory signature + the per-socket-scope encoding (closing over `connId`,
 * requiring `ConnectionManagerTag`, providing `PrincipalResolution` +
 * `ConnectionTag`) is the substrate the native cutover binds.
 */
import { Effect, Layer } from "effect";
import { PrincipalResolution } from "@moltzap/protocol";
import type { JsonRpcMethod } from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";
import { ConnectionManagerTag, ConnectionTag } from "../app/layers.js";
import type { PrincipalKindTable } from "./server-method-bindings.js";
import {
  narrowByPolicy,
  noPolicy,
  peekLiveArm,
  type WireError,
} from "./principal-gate.js";

/**
 * Build the per-connection resolver Layer. Requires `ConnectionManagerTag` (the
 * app-level shared manager it peeks `connId` against — the only shared
 * dependency; the resolver state itself is per-socket). Provides
 * `PrincipalResolution` (the gate + `CurrentPrincipal`) and `ConnectionTag` (the
 * live arm for the unauth path).
 */
export const makePrincipalResolutionLayer = (
  connId: ConnectionId,
  principalKinds: PrincipalKindTable,
): Layer.Layer<
  PrincipalResolution | ConnectionTag,
  never,
  ConnectionManagerTag
> => {
  const resolution = Effect.gen(function* () {
    const manager = yield* ConnectionManagerTag;
    // The `@effect/rpc` middleware impl: payload-only, no `ctx`. Per request it
    // re-peeks the live arm (the constant mux `clientId` is ignored), looks up
    // the method's #720 policy by the live `rpc._tag`, and narrows to the
    // request's `CurrentPrincipal`. A tag with no policy is a gated method that
    // reached the engine without one — fail CLOSED, never a permissive default.
    return ({ rpc }: { readonly rpc: { readonly _tag: string } }) =>
      Effect.gen(function* () {
        const connection = yield* peekLiveArm(manager, connId);
        const policy = principalKinds.get(rpc._tag as JsonRpcMethod);
        if (policy === undefined) {
          return yield* Effect.fail<WireError>(noPolicy());
        }
        return yield* narrowByPolicy(
          policy.callablePrincipal,
          policy.requiresActive,
          connection,
        );
      }).pipe(Effect.withSpan("PrincipalResolution"));
  }).pipe(Effect.withSpan("makePrincipalResolutionLayer"));

  // `ConnectionTag` carries the live 3-arm `Connection` the unauth
  // `network/connect` path reads. It is peeked from the same per-socket
  // manager; `network/connect` runs while the arm is still unauthenticated.
  const connectionArm = Effect.gen(function* () {
    const manager = yield* ConnectionManagerTag;
    return yield* peekLiveArm(manager, connId);
  }).pipe(Effect.withSpan("makePrincipalResolutionLayer.connectionArm"));

  return Layer.merge(
    Layer.effect(PrincipalResolution, resolution),
    Layer.effect(ConnectionTag, connectionArm),
  );
};
