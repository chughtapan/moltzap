import { Effect, Option } from "effect";
import {
  PROTOCOL_VERSION,
  Connect,
  compareProtocolVersion,
  ProtocolMismatchError,
  UnauthorizedError,
  type HelloOk,
  type ParamsOf,
  type ProtocolMismatchReason,
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

/**
 * Architect plan #706 v9 (codex r8 P2 #1) — parameterized
 * protocol-range gate.
 *
 * Raised by `handleConnect` BEFORE auth resolution. When the client's
 * `[minProtocol, maxProtocol]` interval does not bracket the supplied
 * `serverVersion`, fail with a typed `ProtocolMismatchError` carrying
 * the diagnostic triple
 * { clientMinProtocol, clientMaxProtocol, serverVersion, reason }
 * in the wire-error `data` payload.
 *
 * **v9 parameterization (codex r8 P2 #1).** v8 closed over the
 * `PROTOCOL_VERSION` constant directly, which broke the testability
 * of the rejection regression cases: per the release-tooling-managed
 * bump convention, the constant stays at `2026.526.0` on this
 * branch, but the required "old client max `2026.526.0` vs server
 * `2026.527.0`" regression needs to inject a future server version.
 * v9 injects `serverVersion: string` so production passes
 * `PROTOCOL_VERSION` and tests can substitute future versions.
 *
 * The check uses {@link compareProtocolVersion} (numeric segment-wise
 * CalVer comparator from `@moltzap/protocol`) rather than raw string
 * comparison — CalVer values of the form `YYYY.NNNN.M` with
 * variable-digit middle components are NOT lex-sortable.
 *
 * Two reasons (mutually exclusive — the discriminator is in the
 * `data.reason` field):
 *
 * - `server-above-client-max` —
 *   `compareProtocolVersion(serverVersion, client.maxProtocol) > 0`.
 *   The server is newer than the client knows how to talk to.
 * - `server-below-client-min` —
 *   `compareProtocolVersion(serverVersion, client.minProtocol) < 0`.
 *   The client is newer than the server supports.
 *
 * Architect lands the real body — it's a small typed branch and the
 * full integration contract is exercised by impl-staff's regression
 * tests (see architect plan §8). The function lives here in
 * `identity/handlers/connect.handlers.ts` as a private helper so the
 * wiring decision (handler-private vs reusable utility) is closed.
 */
function checkProtocolRange(
  params: ConnectParams,
  serverVersion: string,
): Effect.Effect<void, ProtocolMismatchError> {
  if (compareProtocolVersion(serverVersion, params.maxProtocol) > 0) {
    return failProtocolMismatch(
      params,
      "server-above-client-max",
      serverVersion,
    );
  }
  if (compareProtocolVersion(serverVersion, params.minProtocol) < 0) {
    return failProtocolMismatch(
      params,
      "server-below-client-min",
      serverVersion,
    );
  }
  return Effect.void;
}

/**
 * Construct + raise a {@link ProtocolMismatchError} carrying the
 * diagnostic triple in `data.reason`. Architect plan #706 v8 + v9
 * parameterization.
 *
 * The wire error is registered in `@moltzap/protocol/network/methods.ts`
 * with `static code = -32006` and self-registers via
 * `registerErrorClass`. The discriminant `reason` lives in the
 * `data` field per the wire-error convention (see
 * `@moltzap/protocol/transport/wire-errors.ts → RpcErrorPayload`).
 *
 * **v9 (codex r8 P2 #1):** `serverVersion` injected alongside
 * `params` + `reason` so the diagnostic payload carries the
 * caller-supplied value (production = `PROTOCOL_VERSION`, tests =
 * substituted future version).
 */
function failProtocolMismatch(
  params: ConnectParams,
  reason: ProtocolMismatchReason,
  serverVersion: string,
): Effect.Effect<never, ProtocolMismatchError> {
  return Effect.fail(
    new ProtocolMismatchError({
      data: {
        clientMinProtocol: params.minProtocol,
        clientMaxProtocol: params.maxProtocol,
        serverVersion,
        reason,
      },
    }),
  );
}

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
