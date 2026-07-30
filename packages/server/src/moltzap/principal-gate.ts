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
  type PrincipalRequirement,
} from "@moltzap/protocol/identity";
import { ForbiddenError } from "@moltzap/protocol/rpc";
import type { ConnectionId } from "@moltzap/protocol/socket";
import type {
  ConnectionManager,
  Connection,
  AgentContext,
  AppContext,
} from "#socket";

type Principal = AgentContext | AppContext;

const FORBIDDEN_AGENT_ONLY =
  "This method is callable only by an agent principal";
const FORBIDDEN_APP_ONLY = "This method is callable only by an app principal";
const FORBIDDEN_AUTHENTICATED_ONLY =
  "This method requires an authenticated principal";
const FORBIDDEN_INACTIVE = "Agent must be active before performing this action";

/**
 * A wrong-principal / inactive rejection as the tagged `ForbiddenError`.
 * @param message Value supplied to the operation.
 * @returns The forbidden result.
 */
const forbidden = (message: string): ForbiddenError =>
  new ForbiddenError({ message });

/**
 * Peek the live arm by `connId` off the shared manager. A missing entry is an
 * impossible-state defect: the socket-open path inserts the unauthenticated arm
 * before any resolver Layer is built in the same scope, and the close finalizer
 * removes it only as that scope tears down.
 * @param manager Value supplied to the operation.
 * @param connId Value supplied to the operation.
 * @returns The peek live arm result.
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
 * Narrow the live arm to the agent principal. Rejects a non-agent arm and,
 * for `ActiveAgent` requirements, an inactive agent.
 * @param connection Value supplied to the operation.
 * @param requireActiveAgent Value supplied to the operation.
 * @returns The narrow agent arm result.
 */
const narrowAgentArm = (
  connection: Connection,
  requireActiveAgent: boolean,
): Effect.Effect<Principal, ForbiddenError> => {
  if (connection._tag !== "AgentConnection") {
    return Effect.fail(forbidden(FORBIDDEN_AGENT_ONLY));
  }
  if (requireActiveAgent && connection.auth.agentStatus !== "active") {
    return Effect.fail(forbidden(FORBIDDEN_INACTIVE));
  }
  return Effect.succeed(connection.auth);
};

/**
 * Narrow the live arm to the app principal.
 * @param connection Value supplied to the operation.
 * @returns The narrow app arm result.
 */
const narrowAppArm = (
  connection: Connection,
): Effect.Effect<Principal, ForbiddenError> =>
  connection._tag === "AppConnection"
    ? Effect.succeed(connection.auth)
    : Effect.fail(forbidden(FORBIDDEN_APP_ONLY));

/**
 * Admit either authenticated arm, rejecting the pre-connect arm.
 * @param connection Value supplied to the operation.
 * @returns The narrow authenticated arm result.
 */
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
 * @param requireActiveAgent Value supplied to the operation.
 * @param connection Value supplied to the operation.
 * @param principal Value supplied to the operation.
 * @returns The narrow by policy result.
 */
export const narrowByPolicy = (
  requireActiveAgent: boolean,
  connection: Connection,
  principal?: PrincipalRequirement,
): Effect.Effect<Principal, ForbiddenError> => {
  if (principal === AgentPrincipal) {
    return narrowAgentArm(connection, requireActiveAgent);
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
