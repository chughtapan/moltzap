import { Effect, Option } from "effect";
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
import type {
  AuthenticatedContext,
  RpcMethodRegistry,
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
import type {
  ConnectionManager,
  MoltZapConnection,
} from "../../transport/connection.js";

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
  conn: MoltZapConnection,
  auth: AuthenticatedContext,
  conversationService: ConversationService,
  _db: Db,
) {
  return Effect.gen(function* () {
    const convIds = yield* conversationService.getConversationIds(auth.agentId);
    for (const id of convIds) conn.conversationIds.add(id);
  }).pipe(Effect.withSpan("connect.hydrateConnectionState"));
}

function registerEndpointIfStillConnected(
  connections: ConnectionManager,
  resolver: AgentEndpointResolver,
  connId: ConnectionId,
  auth: AuthenticatedContext,
) {
  return Effect.gen(function* () {
    if (connections.get(connId)) {
      yield* resolver.add(auth.agentId, connId);
    }
  }).pipe(Effect.withSpan("connect.registerEndpointIfStillConnected"));
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

      if (conn.auth) {
        return yield* buildHelloOk(conn.auth, conn.id, presenceService);
      }

      const auth = yield* resolveAuthenticatedContext(
        params,
        authService,
        sessionValidator,
        db,
      );
      conn.auth = auth;
      yield* hydrateConnectionState(conn, auth, conversationService, db);
      yield* registerEndpointIfStillConnected(
        connections,
        agentEndpointResolver,
        conn.id,
        auth,
      );
      return yield* buildHelloOk(auth, conn.id, presenceService);
    }).pipe(Effect.withSpan("network.connect")),
  );
}

export const connectHandlers: RpcMethodRegistry = [
  defineTaskMethod(Connect, {
    handler: handleConnect,
  }),
];
