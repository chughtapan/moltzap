/**
 * @file The principal-kind gate, consumed by the per-method `AuthMiddleware`
 * impl Layers (`auth-middleware-layers.ts`).
 *
 * The gate narrows the live 3-arm `Connection` to the 2-arm `Principal` a
 * method's `requires` head demands, failing with a `ForbiddenError` INSTANCE.
 * The `@effect/rpc` engine encodes that tagged error against the method's
 * per-method error union (the middleware `failure` schema), so there is no
 * coded-envelope projection step. The narrowing and the `requires` head are the
 * SAME arm by construction: an `AgentPrincipal` head yields the agent arm, an
 * `AppPrincipal` head the app arm.
 */
import { Effect, Option } from "effect";
import {
  AgentPrincipal,
  AppPrincipal,
  AuthenticatedPrincipal,
  ForbiddenError,
} from "@moltzap/protocol/transport";
import type {
  Principal,
  PrincipalRequirement,
} from "@moltzap/protocol/requirements";
import type { ConnectionId } from "@moltzap/protocol/runtime";
import type { ConnectionManager, Connection } from "./connection.js";

const FORBIDDEN_AGENT_ONLY =
  "This method is callable only by an agent principal";
const FORBIDDEN_APP_ONLY = "This method is callable only by an app principal";
const FORBIDDEN_AUTHENTICATED_ONLY =
  "This method requires an authenticated principal";
const FORBIDDEN_INACTIVE = "Agent must be active before performing this action";

/** A wrong-principal / inactive rejection as the tagged `ForbiddenError`. */
const forbidden = (message: string): ForbiddenError =>
  new ForbiddenError({ message });

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
 * Narrow the live arm to the agent principal. Rejects a non-agent arm and
 * (when `requireClaimed`) a not-yet-claimed agent.
 */
const narrowAgentArm = (
  connection: Connection,
  requireClaimed: boolean,
): Effect.Effect<Principal, ForbiddenError> => {
  if (connection._tag !== "AgentConnection") {
    return Effect.fail(forbidden(FORBIDDEN_AGENT_ONLY));
  }
  if (requireClaimed && connection.auth.agentStatus !== "active") {
    return Effect.fail(forbidden(FORBIDDEN_INACTIVE));
  }
  return Effect.succeed(connection.auth);
};

/** Narrow the live arm to the app principal. */
const narrowAppArm = (
  connection: Connection,
): Effect.Effect<Principal, ForbiddenError> =>
  connection._tag === "AppConnection"
    ? Effect.succeed(connection.auth)
    : Effect.fail(forbidden(FORBIDDEN_APP_ONLY));

/** Admit either authenticated arm, rejecting the pre-connect arm. */
const narrowAuthenticatedArm = (
  connection: Connection,
): Effect.Effect<Principal, ForbiddenError> =>
  connection._tag === "AgentConnection" || connection._tag === "AppConnection"
    ? Effect.succeed(connection.auth)
    : Effect.fail(forbidden(FORBIDDEN_AUTHENTICATED_ONLY));

/**
 * Narrow the live arm to the principal a gated method's `requires` head demands.
 * A gated method always has a principal head: the empty-`requires` Connect path
 * carries no policy and never reaches this gate, so an `undefined` head here is a
 * wiring defect, not a caller-actionable error.
 */
export const narrowByPolicy = (
  principal: PrincipalRequirement | undefined,
  requireClaimed: boolean,
  connection: Connection,
): Effect.Effect<Principal, ForbiddenError> => {
  if (principal === AgentPrincipal) {
    return narrowAgentArm(connection, requireClaimed);
  }
  if (principal === AppPrincipal) {
    return narrowAppArm(connection);
  }
  if (principal === AuthenticatedPrincipal) {
    return narrowAuthenticatedArm(connection);
  }
  return Effect.dieMessage(
    "principal gate: a gated method carried no principal requirement",
  );
};
