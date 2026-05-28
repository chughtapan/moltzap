import { Effect, Option } from "effect";
import {
  PROTOCOL_VERSION,
  Connect,
  // v10 (codex r9 P2 #1): `checkProtocolRange` relocated to
  // `@moltzap/protocol/version.ts` (alongside
  // `compareProtocolVersion`) so regression tests can import the
  // helper directly from `@moltzap/protocol` without an illegal
  // seam through this server-internal handler module.
  // `compareProtocolVersion` + `ProtocolMismatchError` +
  // `ProtocolMismatchReason` are now closed over by the relocated
  // helper; no longer imported here.
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
  SessionValidatorTag,
} from "../../app/layers.js";
import type { ConnectionId } from "@moltzap/protocol/network";
import type { AgentEndpointResolver } from "../../network/agent-endpoint-resolver.js";
import type { AuthService } from "../../identity/services/auth.service.js";
import { PresenceProjectionTag } from "../../network/services/presence-projection.js";
import type { PresenceProjection } from "../../network/services/presence-projection.js";
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
  presenceProjection: PresenceProjection,
): Effect.Effect<HelloOk, UnauthorizedError | InvalidParamsError> {
  // v7 (codex r6 P2 #2): WS connect emits via the projection's
  // `onAgentConnect(agentId, connId)` lifecycle method. v6 (codex
  // r5 P2 #1) threads connId for the fast-reconnect race guard.
  // The projection drives the wire emission through the sealed
  // `EmitIfChanged` capability; `PresenceService` is no longer
  // involved in status mutation.
  return Effect.gen(function* () {
    yield* presenceProjection.onAgentConnect(ctx.agentId, connId);
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

// v10 (codex r9 P2 #1): `checkProtocolRange` + `failProtocolMismatch`
// relocated to `@moltzap/protocol/version.ts`. v8/v9 kept them here
// as private functions, which made the v9-parameterized signature
// testable in principle but the actual function unreachable from a
// regression test without an illegal `import { checkProtocolRange }
// from "../../identity/handlers/connect.handlers.js"` seam. v10
// exports `checkProtocolRange` from `@moltzap/protocol` so tests can
// import + inject a future `serverVersion` cleanly.
//
// `failProtocolMismatch` stays module-private to `version.ts`
// (NOT exported) — its only caller is `checkProtocolRange`, and
// making it private encodes "this is the canonical raise path for
// ProtocolMismatchError on the server side."

function handleConnect(params: ConnectParams) {
  return catchSqlErrorAsDefect(
    Effect.gen(function* () {
      // v8 (architect plan #706 / codex r7 P2 #1): protocol-range gate
      // BEFORE auth resolution. Old clients (and clients newer than
      // the server supports) are rejected at the version edge — they
      // never see the credential check, so no partial state leaks
      // before the rejection.
      //
      // v9 (codex r8 P2 #1): the helper is parameterized over
      // `serverVersion`; production passes the live `PROTOCOL_VERSION`
      // constant while tests inject future-version values to exercise
      // rejection paths against an unbumped branch.
      yield* checkProtocolRange(params, PROTOCOL_VERSION);

      const authService = yield* AuthServiceTag;
      const conversationService = yield* ConversationServiceTag;
      const presenceProjection = yield* PresenceProjectionTag;
      const connections = yield* ConnectionManagerTag;
      const agentEndpointResolver = yield* AgentEndpointResolverTag;
      const db = yield* DbTag;
      const sessionValidator = yield* SessionValidatorTag;
      const conn = yield* ConnectionTag;

      if (conn.auth) {
        return yield* buildHelloOk(conn.auth, conn.id, presenceProjection);
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
      return yield* buildHelloOk(auth, conn.id, presenceProjection);
    }).pipe(Effect.withSpan("network.connect")),
  );
}

export const connectHandlers: RpcMethodRegistry = [
  defineTaskMethod(Connect, {
    handler: handleConnect,
  }),
];
