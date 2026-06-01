/**
 * @file The #720 principal-kind gate, consumed by the per-method `AuthMiddleware`
 * impl Layers (`auth-middleware-layers.ts`).
 *
 * The gate narrows the live 3-arm `Connection` to the 2-arm `Principal` a
 * method's policy demands, failing with the coded {@link WireError} envelope the
 * `@effect/rpc` middleware `failure` schema (`WireErrorSchema`) carries. The
 * narrowing and the descriptor's `callablePrincipal` are the SAME arm by
 * construction: an `"agent"` policy yields the agent arm, `"app"` the app arm.
 */
import { absurd, Effect, Option } from "effect";
import {
  ForbiddenError,
  JSON_RPC_RESERVED_CODES,
  wireErrorFromInstance,
} from "@moltzap/protocol";
import type { Principal, WireError } from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";
import type { ConnectionManager, Connection } from "./connection.js";

export type { WireError };

/** The principal axis a gated method's policy demands (descriptor `callablePrincipal`). */
type CallablePrincipal = "agent" | "app" | "any";

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
 * Peek the live arm by `connId` off the shared manager. A missing entry is an
 * impossible-state defect: the socket-open path inserts the unauthenticated arm
 * before any resolver Layer is built in the same scope, and the close finalizer
 * removes it only as that scope tears down.
 */
export const peekLiveArm = (
  manager: ConnectionManager,
  connId: ConnectionId,
): Effect.Effect<Connection> =>
  manager.peek(connId).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.dieMessage(
            `principal gate: no connection arm for connId=${connId}`,
          ),
        onSome: Effect.succeed,
      }),
    ),
  );

/**
 * Narrow the live arm to the agent principal (#705 #720 §B1). Rejects a
 * non-agent arm and (when `requiresActive`) a not-yet-claimed agent.
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
 * Narrow the live arm to the principal a gated method's policy demands. Gated
 * policies are never `"any"` (`projectPrincipalKinds` rejects an authenticated
 * binding carrying `"any"`, and the per-method Layers pass a literal
 * `"agent"`/`"app"`); the `"any"` Connect path carries no policy and never
 * reaches this gate. An `"any"` here is therefore a wiring defect, not a
 * caller-actionable error.
 */
export const narrowByPolicy = (
  callablePrincipal: CallablePrincipal,
  requiresActive: boolean,
  connection: Connection,
): Effect.Effect<Principal, WireError> => {
  switch (callablePrincipal) {
    case "agent":
      return narrowAgentArm(connection, requiresActive);
    case "app":
      return narrowAppArm(connection);
    case "any":
      return Effect.dieMessage(
        "principal gate: a gated method carried callablePrincipal 'any'",
      );
    default:
      return absurd(callablePrincipal);
  }
};

/**
 * Project a cap-obtain failure onto the coded wire envelope the middleware
 * `failure` schema carries. A registered tagged error (e.g. `ForbiddenError`,
 * `NotFoundError`) maps to its `code`/`message`; an unregistered failure is an
 * `InternalError` -32603, the same fallback the dispatcher's Exit projection
 * uses.
 */
export const toWireError = (cause: unknown): WireError =>
  wireErrorFromInstance(cause) ?? {
    code: JSON_RPC_RESERVED_CODES.InternalError,
    message: "Internal error",
  };
