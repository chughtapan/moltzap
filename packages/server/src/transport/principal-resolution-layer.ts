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
import { Effect, Layer, Option } from "effect";
import {
  ForbiddenError,
  PrincipalResolution,
  UnauthorizedError,
  type Principal,
} from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";
import type { JsonRpcMethod } from "@moltzap/protocol";
import { ConnectionManagerTag, ConnectionTag } from "../app/layers.js";
import type { ConnectionManager, Connection } from "./connection.js";
import type {
  PrincipalKindTable,
  PrincipalKindPolicy,
} from "./server-method-bindings.js";

/** The coded wire-error envelope the `PrincipalResolution` failure schema decodes to. */
interface WireError {
  readonly code: number;
  readonly message: string;
}

const FORBIDDEN_AGENT_ONLY =
  "This method is callable only by an agent principal";
const FORBIDDEN_APP_ONLY = "This method is callable only by an app principal";
const FORBIDDEN_INACTIVE =
  "Agent must be claimed before performing this action";

/** A wrong-principal / inactive rejection as the coded wire envelope. */
const forbidden = (message: string): WireError => ({
  code: ForbiddenError.code,
  message,
});

/**
 * Narrow the live arm to the agent principal (#705 #720 §B1). Rejects a
 * non-agent arm and (when `requiresActive`) a not-yet-claimed agent. Fails with
 * the coded wire envelope the middleware's `failure` schema carries.
 */
const narrowAgentArm = (
  connection: Connection,
  requiresActive: boolean,
): Effect.Effect<Principal, WireError> => {
  if (connection._tag !== "AgentConnection") {
    return Effect.fail(forbidden(FORBIDDEN_AGENT_ONLY));
  }
  if (requiresActive && connection.auth.agentStatus !== "active") {
    return Effect.fail(forbidden(FORBIDDEN_INACTIVE));
  }
  return Effect.succeed(connection.auth);
};

/** Narrow the live arm to the app principal (#705 #720 §B1). */
const narrowAppArm = (
  connection: Connection,
): Effect.Effect<Principal, WireError> =>
  connection._tag === "AppConnection"
    ? Effect.succeed(connection.auth)
    : Effect.fail(forbidden(FORBIDDEN_APP_ONLY));

/**
 * Apply the principal-kind gate (#705 #720 §B1) to the live arm under a gated
 * method's policy. Gated policies are never `"any"` (`projectPrincipalKinds`
 * rejects an authenticated binding carrying `"any"`), so the gate always narrows
 * to a real {@link Principal}; the `"any"` Connect path carries no policy and
 * never reaches this gate.
 */
const narrowByPolicy = (
  policy: PrincipalKindPolicy,
  connection: Connection,
): Effect.Effect<Principal, WireError> =>
  policy.callablePrincipal === "app"
    ? narrowAppArm(connection)
    : narrowAgentArm(connection, policy.requiresActive);

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
  // The arm is reached by the closed-over `connId` off the shared manager. A
  // missing entry is an impossible-state defect: the socket-open path inserts
  // the unauthenticated arm before this Layer is built in the same scope, and
  // the close finalizer removes it only as the scope tears down.
  const peekArm = (manager: ConnectionManager): Effect.Effect<Connection> =>
    manager.peek(connId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.dieMessage(
              `PrincipalResolution: no connection arm for connId=${connId}`,
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const resolution = Effect.gen(function* () {
    const manager = yield* ConnectionManagerTag;
    // The `@effect/rpc` middleware impl: payload-only, no `ctx`. Per request it
    // re-peeks the live arm (the constant mux `clientId` is ignored), looks up
    // the method's #720 policy by the live `rpc._tag`, and narrows to the
    // request's `CurrentPrincipal`. A tag with no policy is a gated method that
    // reached the engine without one — fail CLOSED, never a permissive default.
    return ({ rpc }: { readonly rpc: { readonly _tag: string } }) =>
      Effect.gen(function* () {
        const connection = yield* peekArm(manager);
        const policy = principalKinds.get(rpc._tag as JsonRpcMethod);
        if (policy === undefined) {
          return yield* Effect.fail<WireError>({
            code: UnauthorizedError.code,
            message: UnauthorizedError.message,
          });
        }
        return yield* narrowByPolicy(policy, connection);
      }).pipe(Effect.withSpan("PrincipalResolution"));
  }).pipe(Effect.withSpan("makePrincipalResolutionLayer"));

  // `ConnectionTag` carries the live 3-arm `Connection` the unauth
  // `network/connect` path reads. It is peeked from the same per-socket
  // manager; `network/connect` runs while the arm is still unauthenticated.
  const connectionArm = Effect.gen(function* () {
    const manager = yield* ConnectionManagerTag;
    return yield* peekArm(manager);
  }).pipe(Effect.withSpan("makePrincipalResolutionLayer.connectionArm"));

  return Layer.merge(
    Layer.effect(PrincipalResolution, resolution),
    Layer.effect(ConnectionTag, connectionArm),
  );
};
