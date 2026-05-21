import { Effect, Option } from "effect";
import {
  PROTOCOL_VERSION,
  Connect,
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
  ConnIdTag,
  ConnectionManagerTag,
  ConversationServiceTag,
  DbTag,
  PresenceServiceTag,
  SessionValidatorTag,
} from "../../app/layers.js";
import { connectionId as brandConnectionId } from "../../network/agent-endpoint-resolver.js";
import type { AgentEndpointResolver } from "../../network/agent-endpoint-resolver.js";
import type { AuthService } from "../../identity/services/auth.service.js";
import type { PresenceService } from "../../network/services/presence.service.js";
import type { SessionValidator } from "../../identity/services/session-validator.js";
import type { Db } from "../../db/client.js";
import type { ConversationService } from "../services/conversation.service.js";
import { InvalidParamsError } from "../../runtime/index.js";
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
  presenceService: PresenceService,
): Effect.Effect<HelloOk, UnauthorizedError | InvalidParamsError> {
  return Effect.sync(() => {
    presenceService.setOnline(ctx.agentId);
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
    // Spec D3 R14: `conversation_participants.muted_until` retires; mute
    // is now a client-local concern. The server no longer hydrates a
    // muted-conversation set per connection.
  }).pipe(Effect.withSpan("connect.hydrateConnectionState"));
}

function registerEndpointIfStillConnected(
  connections: ConnectionManager,
  resolver: AgentEndpointResolver,
  connId: string,
  auth: AuthenticatedContext,
) {
  return Effect.gen(function* () {
    if (connections.get(connId)) {
      yield* resolver.add(auth.agentId, brandConnectionId(connId));
    }
  }).pipe(Effect.withSpan("connect.registerEndpointIfStillConnected"));
}

function handleConnect(params: ConnectParams) {
  return catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const authService = yield* AuthServiceTag;
      const conversationService = yield* ConversationServiceTag;
      const presenceService = yield* PresenceServiceTag;
      const connections = yield* ConnectionManagerTag;
      const agentEndpointResolver = yield* AgentEndpointResolverTag;
      const db = yield* DbTag;
      const sessionValidator = yield* SessionValidatorTag;
      const connId = yield* ConnIdTag;
      const conn = connections.get(connId);

      if (!conn) {
        return yield* Effect.fail(
          new UnauthorizedError({ message: "Connection not found" }),
        );
      }
      if (conn.auth) {
        return yield* buildHelloOk(conn.auth, presenceService);
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
        connId,
        auth,
      );
      return yield* buildHelloOk(auth, presenceService);
    }).pipe(Effect.withSpan("network.connect")),
  );
}

export const connectHandlers: RpcMethodRegistry = [
  defineTaskMethod(Connect, {
    handler: handleConnect,
  }),
];
