/**
 * @file The per-connection runtime for the protocol-owned `PrincipalResolution`
 * middleware + the request-scoped `ConnectionTag`.
 *
 * `makePrincipalResolutionLayer(connId, principalKinds)` is constructed ONLY by
 * the socket-open path inside that connection's `Scope`, closing over its
 * `ConnectionId`. It is NEVER app-memoized or shared: a shared instance would
 * collide every connection on the constant `MUX_CLIENT_ID` and resolve the wrong
 * principal — cross-connection principal cross-talk. On each request the gate
 * reads the LIVE arm by the closed-over `connId` (snapshotted once per request);
 * `clientId` is ignored (constant per mux). It runs the #720 gate
 * (`narrowPrincipalCtx` keyed by `principalKinds`) and provides the narrowed
 * `CurrentPrincipal`; `ConnectionTag` carries the unnarrowed 3-arm `Connection`
 * for the unauth `network/connect` path.
 *
 * The factory signature + the per-socket-scope encoding (closing over `connId`,
 * requiring `ConnectionManagerTag`, providing `PrincipalResolution` +
 * `ConnectionTag`) is the substrate the native cutover binds; the gate
 * relocation from `context.ts → narrowPrincipalCtx` into this impl lands with
 * the live-connection cutover.
 */
import { Effect, Layer } from "effect";
import { PrincipalResolution } from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";
import { ConnectionManagerTag, ConnectionTag } from "../app/layers.js";
import type { PrincipalKindTable } from "./server-method-bindings.js";

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
  // The gate impl reads `ConnectionManagerTag.peek(connId)`, narrows by
  // `principalKinds.get(rpc._tag)` (a miss fails CLOSED with `ForbiddenError`),
  // and provides the narrowed `CurrentPrincipal` + the live `ConnectionTag` arm.
  // The additive substrate pins the factory signature + the per-socket-scope
  // encoding (closing over `connId`, requiring `ConnectionManagerTag`); the gate
  // relocation from `context.ts → narrowPrincipalCtx` lands with the cutover.
  const notWired = Effect.gen(function* () {
    yield* ConnectionManagerTag;
    return yield* Effect.dieMessage(
      `makePrincipalResolutionLayer is wired by the live-connection cutover (connId=${connId}, ${principalKinds.size} gated policies, manager peeked per request)`,
    );
  }).pipe(Effect.withSpan("makePrincipalResolutionLayer"));
  return Layer.merge(
    Layer.effect(PrincipalResolution, notWired),
    Layer.effect(ConnectionTag, notWired),
  );
};
