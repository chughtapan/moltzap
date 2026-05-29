import { Effect, Match, Option } from "effect";
import {
  PROTOCOL_VERSION,
  Connect,
  // `checkProtocolRange` lives in `@moltzap/protocol/version.ts` so
  // regression tests can import it directly without an illegal seam
  // through this server-internal handler module.
  checkProtocolRange,
  UnauthorizedError,
  type HelloOk,
  type ParamsOf,
} from "@moltzap/protocol";
import {
  agentContextFromAuthenticated,
  type AuthenticatedContext,
  type RpcMethodRegistry,
} from "../../transport/context.js";
import { defineTaskMethod } from "../../transport/define-layered-method.js";
import {
  AgentEndpointResolverTag,
  AuthServiceTag,
  ConnectionTag,
  ConnectionManagerTag,
  ConversationServiceTag,
  DbTag,
  PresenceServiceTag,
  SessionValidatorTag,
} from "../../app/layers.js";
import type { ConnectionId } from "@moltzap/protocol/network";
import type { AgentEndpointResolver } from "../../network/agent-endpoint-resolver.js";
import type { AuthService } from "../../identity/services/auth.service.js";
import type { PresenceService } from "../../network/services/presence.service.js";
import type { SessionValidator } from "../../identity/services/session-validator.js";
import type { Db } from "../../db/client.js";
import type { ConversationService } from "../../task/services/conversation.service.js";
import { InvalidParamsError } from "@moltzap/protocol";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
} from "../../db/effect-kysely-toolkit.js";
import type { ConnectionManager } from "../../transport/connection.js";

type ConnectParams = ParamsOf<typeof Connect>;

/** Agent API-key path — existing behavior, typed `never` from authService. */
function authenticateAgentKey(
  agentKey: string,
  authService: AuthService,
): Effect.Effect<AuthenticatedContext, UnauthorizedError> {
  return Effect.gen(function* () {
    const agent = yield* authService.authenticateAgent(agentKey);
    if (!agent) {
      return yield* Effect.fail(
        new UnauthorizedError({ message: "Authentication failed" }),
      );
    }
    return {
      agentId: agent.agentId,
      agentStatus: agent.status,
      ownerUserId: agent.ownerUserId,
    };
  }).pipe(Effect.withSpan("connect.authenticateAgentKey"));
}

/**
 * App-minted bearer-token path. Resolves the session via
 * `SessionValidator.validateSession`, then looks up the agent status so
 * `requiresActive` gating still works for the bearer path.
 */
function authenticateSession(
  token: string,
  sessionValidator: SessionValidator | null,
  db: Db,
): Effect.Effect<AuthenticatedContext, UnauthorizedError> {
  return catchSqlErrorAsDefect(
    Effect.gen(function* () {
      if (!sessionValidator) {
        return yield* Effect.fail(
          new UnauthorizedError({
            message: "Session tokens not supported by this server",
          }),
        );
      }
      const result = yield* sessionValidator.validateSession(token);
      if (!result.valid) {
        return yield* Effect.fail(
          new UnauthorizedError({ message: "Authentication failed" }),
        );
      }
      if (result.agentStatus !== undefined) {
        return {
          agentId: result.agentId,
          agentStatus: result.agentStatus,
          ownerUserId: result.ownerUserId,
        };
      }
      const rowOpt = yield* takeFirstOption(
        db
          .selectFrom("agents")
          .select("status")
          .where("id", "=", result.agentId),
      );
      if (Option.isNone(rowOpt)) {
        return yield* Effect.fail(
          new UnauthorizedError({ message: "Authentication failed" }),
        );
      }
      return {
        agentId: result.agentId,
        agentStatus: rowOpt.value.status,
        ownerUserId: result.ownerUserId,
      };
    }).pipe(Effect.withSpan("connect.authenticateSession")),
  );
}

function buildHelloOk(
  ctx: AuthenticatedContext,
  connId: ConnectionId,
  presenceService: PresenceService,
): Effect.Effect<HelloOk, UnauthorizedError | InvalidParamsError> {
  // WS connect emits via `onAgentConnect(agentId, connId)`. connId is
  // threaded for the fast-reconnect race guard.
  return Effect.gen(function* () {
    yield* presenceService.onAgentConnect(ctx.agentId, connId);
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentId: ctx.agentId,
      policy: {
        maxMessageBytes: 65536,
        maxPartsPerMessage: 10,
        maxTextLength: 32768,
        maxGroupParticipants: 256,
        heartbeatIntervalMs: 30000,
        rateLimits: {
          messagesPerMinute: 60,
          requestsPerMinute: 120,
        },
      },
    };
  }).pipe(Effect.withSpan("connect.buildHelloOk"));
}

function resolveAuthenticatedContext(
  params: ConnectParams,
  authService: AuthService,
  sessionValidator: SessionValidator | null,
  db: Db,
): Effect.Effect<AuthenticatedContext, UnauthorizedError> {
  if ("sessionToken" in params) {
    return authenticateSession(params.sessionToken, sessionValidator, db);
  }
  return authenticateAgentKey(params.agentKey, authService);
}

function hydrateConnectionState(
  connections: ConnectionManager,
  connId: ConnectionId,
  auth: AuthenticatedContext,
  conversationService: ConversationService,
) {
  return Effect.gen(function* () {
    const convIds = yield* conversationService.getConversationIds(auth.agentId);
    // D #705 CP4e — seed the three-arm `connectionsRef` agent arm's
    // subscription set (the fan-out gate now reads it). The arm was minted by
    // `mirrorAgentArmTransition` just above, so it exists for this connId.
    yield* connections.hydrateConversationIds(connId, convIds);
  }).pipe(Effect.withSpan("connect.hydrateConnectionState"));
}

function registerEndpointIfStillConnected(
  connections: ConnectionManager,
  resolver: AgentEndpointResolver,
  connId: ConnectionId,
  auth: AuthenticatedContext,
) {
  return Effect.gen(function* () {
    // D #705 CP4d — read the three-arm `connectionsRef` arm; the legacy map
    // is no longer consulted on the dispatch path.
    if (Option.isSome(yield* connections.peek(connId))) {
      yield* resolver.add(auth.agentId, connId);
    }
  }).pipe(Effect.withSpan("connect.registerEndpointIfStillConnected"));
}

/**
 * D #705 CP4a EXPAND — mirror the legacy `conn.auth` mutation onto the
 * three-arm `connectionsRef` via the immutable transition. The agent arm is
 * minted from the resolved `AuthenticatedContext`; the app arm arrives in CP5
 * (appKey Connect). All `TransitionOutcome` arms are matched exhaustively.
 * `not-connected` is a benign race (the close handler removed the entry);
 * `already-connected` mirrors the legacy re-auth no-op (a fresh `HelloOk`).
 */
function mirrorAgentArmTransition(
  connections: ConnectionManager,
  connId: ConnectionId,
  auth: AuthenticatedContext,
): Effect.Effect<void> {
  return agentContextFromAuthenticated(auth).pipe(
    Effect.flatMap((agentCtx) => connections.authenticate(connId, agentCtx)),
    Effect.flatMap((outcome) =>
      Match.value(outcome).pipe(
        Match.when({ kind: "ok-agent" }, () => Effect.void),
        Match.when({ kind: "ok-app" }, () => Effect.void),
        Match.when({ kind: "already-connected" }, () => Effect.void),
        Match.when({ kind: "not-connected" }, () => Effect.void),
        Match.exhaustive,
      ),
    ),
  );
}

function handleConnect(params: ConnectParams) {
  return catchSqlErrorAsDefect(
    Effect.gen(function* () {
      // Protocol-range gate runs BEFORE auth resolution: clients
      // outside the supported version range are rejected at the version
      // edge, so no partial state leaks before the rejection. A
      // malformed `min/maxProtocol` string raises
      // `InvalidProtocolVersionError`, mapped here to the wire-typed
      // `InvalidParamsError` (JSON-RPC -32602) so it surfaces as a typed
      // response rather than an untyped defect. `ProtocolMismatchError`
      // stays in the channel for the well-formed-but-out-of-range case.
      yield* checkProtocolRange(params, PROTOCOL_VERSION).pipe(
        Effect.catchTag("InvalidProtocolVersionError", (cause) =>
          Effect.fail(
            new InvalidParamsError({
              message: `Malformed protocol version ${JSON.stringify(cause.version)}: invalid segment ${JSON.stringify(cause.segment)}`,
            }),
          ),
        ),
      );

      const authService = yield* AuthServiceTag;
      const conversationService = yield* ConversationServiceTag;
      const presenceService = yield* PresenceServiceTag;
      const connections = yield* ConnectionManagerTag;
      const agentEndpointResolver = yield* AgentEndpointResolverTag;
      const db = yield* DbTag;
      const sessionValidator = yield* SessionValidatorTag;
      const conn = yield* ConnectionTag;

      // D #705 CP4d — Connect dispatches on the live arm. A re-Connect on an
      // already-authenticated agent arm is an idempotent no-op that re-emits
      // `HelloOk`; the agent arm's `AgentContext` is a structural
      // `AuthenticatedContext`. The app arm has no agent identity and never
      // reaches this re-Connect path (apps Connect via the appKey arm, CP5).
      if (conn._tag === "AgentConnection") {
        return yield* buildHelloOk(conn.auth, conn.connId, presenceService);
      }

      const auth = yield* resolveAuthenticatedContext(
        params,
        authService,
        sessionValidator,
        db,
      );
      // The agent arm is minted by the immutable transition below; there is
      // no longer a legacy `conn.auth` mutation (the arm IS the auth store).
      yield* mirrorAgentArmTransition(connections, conn.connId, auth);
      yield* hydrateConnectionState(
        connections,
        conn.connId,
        auth,
        conversationService,
      );
      yield* registerEndpointIfStillConnected(
        connections,
        agentEndpointResolver,
        conn.connId,
        auth,
      );
      return yield* buildHelloOk(auth, conn.connId, presenceService);
    }).pipe(Effect.withSpan("network.connect")),
  );
}

export const connectHandlers: RpcMethodRegistry = [
  defineTaskMethod(Connect, {
    handler: handleConnect,
  }),
];
