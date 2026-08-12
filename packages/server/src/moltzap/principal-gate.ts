/**
 * @file Live connection-arm lookup and principal narrowing for requirement
 * middleware and already-gated handler bodies.
 *
 * The gate narrows the live 2-arm `Connection` to the `AgentContext` a gated
 * method's `requires` head demands, failing with a `ForbiddenError` INSTANCE.
 * The `@effect/rpc` engine encodes that tagged error against the method's
 * per-method error union (the middleware `failure` schema), so there is no
 * coded-envelope projection step. `AuthenticatedAgent` is the only principal
 * requirement, so the narrowing and the `requires` head are the SAME arm by
 * construction.
 */
// safer-arch-ignore folder-explicit-api-required: This is the deliberate principal-read facade shared by domain RPC handlers and socket composition.
import { Effect, Option } from "effect";
import {
  AuthenticatedAgent,
  type PrincipalRequirement,
} from "@moltzap/protocol/identity";
import { ForbiddenError } from "@moltzap/protocol/rpc";
import type { ConnectionId } from "@moltzap/protocol/socket";
import {
  ConnectionManagerTag,
  ConnectionTag,
  type AgentContext,
  type Connection,
  type ConnectionManager,
} from "#socket";

const FORBIDDEN_AGENT_ONLY =
  "This method requires an authenticated agent principal";
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
 * Read the live connection arm for this request. `ConnectionTag` is the
 * per-socket build-time snapshot, so only its stable connection id is used to
 * re-read the arm that may have transitioned after connect.
 */
const liveArm = Effect.gen(function* () {
  const snapshot = yield* ConnectionTag;
  const manager = yield* ConnectionManagerTag;
  return yield* peekLiveArm(manager, snapshot.connId);
});

/**
 * Read the agent context after requirement middleware has gated the handler.
 * A non-agent arm is an impossible-state defect because the gate runs first.
 */
export const agentArm: Effect.Effect<
  AgentContext,
  never,
  ConnectionTag | ConnectionManagerTag
> = Effect.gen(function* () {
  const connection = yield* liveArm;
  if (connection._tag !== "AgentConnection") {
    return yield* Effect.dieMessage(
      `handler: agent-gated method reached on ${connection._tag} arm`,
    );
  }
  return connection.auth;
}).pipe(Effect.withSpan("serverHandlers.agentArm"));

/**
 * Narrow the live arm to the agent principal. Rejects the pre-connect arm and,
 * for `ActiveAgent` requirements, an inactive agent.
 * @param connection Value supplied to the operation.
 * @param requireActiveAgent Value supplied to the operation.
 * @returns The narrow agent arm result.
 */
const narrowAgentArm = (
  connection: Connection,
  requireActiveAgent: boolean,
): Effect.Effect<AgentContext, ForbiddenError> => {
  if (connection._tag !== "AgentConnection") {
    return Effect.fail(forbidden(FORBIDDEN_AGENT_ONLY));
  }
  if (requireActiveAgent && connection.auth.agentStatus !== "active") {
    return Effect.fail(forbidden(FORBIDDEN_INACTIVE));
  }
  return Effect.succeed(connection.auth);
};

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
): Effect.Effect<AgentContext, ForbiddenError> => {
  if (principal === AuthenticatedAgent) {
    return narrowAgentArm(connection, requireActiveAgent);
  }
  return Effect.dieMessage(
    "principal gate: a gated method carried no principal requirement",
  );
};
