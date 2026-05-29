import { Effect, Match, Option } from "effect";
import {
  PROTOCOL_VERSION,
  Connect,
  // `checkProtocolRange` lives in `@moltzap/protocol/version.ts` so
  // regression tests can import it directly without an illegal seam
  // through this server-internal handler module.
  checkProtocolRange,
  NotConnectedError,
  UnauthorizedError,
  type AppManifest,
  type HelloOk,
  type ParamsOf,
} from "@moltzap/protocol";
import {
  agentContextFromAuthenticated,
  AppContext,
  type AuthenticatedContext,
  type RpcMethodRegistry,
} from "../../transport/context.js";
import { defineAppMethod } from "../../transport/define-layered-method.js";
import {
  AgentEndpointResolverTag,
  AppAuthServiceTag,
  AppHostTag,
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
import type { AppAuthService } from "../../identity/services/app-auth.service.js";
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
  Originator,
} from "../../transport/connection.js";
import type { AppHost } from "../../app/app-host.js";

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
  // The `appKey` arm is dispatched + returned early in `handleConnect`
  // (CP5), so this agent-side resolver only ever sees the agent/session
  // arms — narrow the parameter to exclude `appKey`.
  params: Exclude<ConnectParams, { readonly appKey: string }>,
  authService: AuthService,
  sessionValidator: SessionValidator | null,
  db: Db,
): Effect.Effect<AuthenticatedContext, UnauthorizedError> {
  if ("sessionToken" in params) {
    return authenticateSession(params.sessionToken, sessionValidator, db);
  }
  return authenticateAgentKey(params.agentKey, authService);
}

/**
 * D #705 CP5 — app-principal Connect builder. The `AppConnection` HelloOk
 * carries NO `agentId` (apps have no agent identity) and skips agent-only
 * hydration (conversation-id seeding, presence, endpoint registration). The
 * server policy is shared with the agent path.
 */
function buildAppHelloOk(): HelloOk {
  return {
    protocolVersion: PROTOCOL_VERSION,
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
}

/**
 * D #705 CP5/CP8 — resolve an `appKey` credential to its `AppContext` AND its
 * decoded `AppManifest` (sourced atomically from the same `authenticateApp`
 * SQL row, so the implicit registration in {@link registerAppArmTransition}
 * has NO post-auth `getManifest` failure surface). A hash MISS (`null` from
 * `authenticateApp`) surfaces a uniform `UnauthorizedError`; a corrupted
 * manifest on a hash-matching row carries `UnauthorizedError`'s
 * `manifest_corrupted` reason (set inside `authenticateApp`).
 */
function authenticateAppKey(
  appKey: string,
  appAuthService: AppAuthService,
): Effect.Effect<
  { auth: AppContext; manifest: AppManifest },
  UnauthorizedError
> {
  return appAuthService.authenticateApp(appKey).pipe(
    Effect.flatMap((resolved) =>
      resolved === null
        ? Effect.fail(
            new UnauthorizedError({ message: "Authentication failed" }),
          )
        : Effect.succeed({ auth: resolved.auth, manifest: resolved.manifest }),
    ),
    Effect.withSpan("connect.authenticateAppKey"),
  );
}

/**
 * D #705 CP8 STEP D + D.5 — register the freshly minted `AppConnection`'s
 * `AppEndpoint` into `AppHost`/`AppRegistry`, then re-peek for a close race.
 *
 *   - STEP D: register `{ connId, originator }` off the live arm. A `false`
 *     return (the registry rejects an overwrite — another live connection
 *     already owns this appId) rolls the arm back + surfaces the uniform
 *     `UnauthorizedError` (the appKey resolved but its slot is occupied).
 *   - STEP D.5: a close that raced between the transition and the
 *     registration leaves a stale registry entry; undo it via
 *     `unregisterAppsForConnection` before failing `NotConnectedError`.
 */
function registerAppEndpoint(args: {
  readonly connections: ConnectionManager;
  readonly appHost: AppHost;
  readonly appId: AppContext["appId"];
  readonly manifest: AppManifest;
  readonly authed: {
    readonly connId: ConnectionId;
    readonly originator: Originator;
  };
}): Effect.Effect<void, UnauthorizedError | NotConnectedError> {
  const { connections, appHost, appId, manifest, authed } = args;
  const connId = authed.connId;
  return Effect.gen(function* () {
    // D #705 CP9 — register under the SERVER-MINTED `appId` (the authenticated
    // principal), NOT `manifest.appId`. `task/request` routes to the appId the
    // registrant received from `/api/v1/apps/register` = this identity.
    const ok = appHost.registerApp(appId, manifest, {
      connId,
      originator: authed.originator,
    });
    if (!ok) {
      yield* connections.rollbackToUnauthenticated(connId);
      return yield* Effect.fail(
        new UnauthorizedError({
          message: `App ${appId} already has an active connection`,
        }),
      );
    }
    const postCheck = yield* connections.peek(connId);
    if (Option.isNone(postCheck) || postCheck.value._tag !== "AppConnection") {
      appHost.unregisterAppsForConnection(connId);
      return yield* Effect.fail(
        new NotConnectedError({
          message: "connection closed during Connect's app-arm registration",
        }),
      );
    }
  }).pipe(Effect.withSpan("connect.registerAppEndpoint"));
}

/**
 * D #705 CP5/CP8 — mint the `AppConnection` arm via the immutable transition
 * AND implicitly register its `AppEndpoint` into `AppHost`/`AppRegistry`
 * (the v36 §3 Connect STEP D for the app arm). An app's routing surface is
 * now minted from the live `AppConnection` arm on appKey Connect — there is
 * no separate WS `apps/register` RPC. Mirrors {@link mirrorAgentArmTransition}
 * for the app principal; all `TransitionOutcome` arms are matched exhaustively:
 * `ok-app` registers the endpoint (see {@link registerAppEndpoint}); `ok-agent`
 * is impossible here (we pass an `AppContext`) — `Effect.die`;
 * `already-connected` is the re-auth no-op (HelloOk re-emitted upstream);
 * `not-connected` is a benign close race.
 */
function registerAppArmTransition(args: {
  readonly connections: ConnectionManager;
  readonly appHost: AppHost;
  readonly connId: ConnectionId;
  readonly auth: AppContext;
  readonly manifest: AppManifest;
}): Effect.Effect<void, UnauthorizedError | NotConnectedError> {
  const { connections, appHost, connId, auth, manifest } = args;
  return connections.authenticate(connId, auth).pipe(
    Effect.flatMap((outcome) =>
      Match.value(outcome).pipe(
        Match.when({ kind: "ok-app" }, ({ authed }) =>
          registerAppEndpoint({
            connections,
            appHost,
            appId: auth.appId,
            manifest,
            authed,
          }),
        ),
        Match.when({ kind: "ok-agent" }, () =>
          Effect.die(
            new Error(
              "registerAppArmTransition: authenticate returned ok-agent for an AppContext",
            ),
          ),
        ),
        Match.when({ kind: "already-connected" }, () => Effect.void),
        Match.when({ kind: "not-connected" }, () => Effect.void),
        Match.exhaustive,
      ),
    ),
  );
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

/**
 * D #705 CP5 — agent/session post-auth flow. Resolves the credential to an
 * `AgentContext`, mints the agent arm via the immutable transition, hydrates
 * the conversation-id subscription set + agent-endpoint registration, then
 * emits the agent-shaped `HelloOk`. Reached only for the non-`appKey` arms
 * (the `appKey` arm returns early in {@link handleConnect}).
 */
function completeAgentConnect(
  params: Exclude<ConnectParams, { readonly appKey: string }>,
  connId: ConnectionId,
) {
  return Effect.gen(function* () {
    const authService = yield* AuthServiceTag;
    const conversationService = yield* ConversationServiceTag;
    const presenceService = yield* PresenceServiceTag;
    const connections = yield* ConnectionManagerTag;
    const agentEndpointResolver = yield* AgentEndpointResolverTag;
    const db = yield* DbTag;
    const sessionValidator = yield* SessionValidatorTag;

    const auth = yield* resolveAuthenticatedContext(
      params,
      authService,
      sessionValidator,
      db,
    );
    // The agent arm is minted by the immutable transition below; there is
    // no longer a legacy `conn.auth` mutation (the arm IS the auth store).
    yield* mirrorAgentArmTransition(connections, connId, auth);
    yield* hydrateConnectionState(
      connections,
      connId,
      auth,
      conversationService,
    );
    yield* registerEndpointIfStillConnected(
      connections,
      agentEndpointResolver,
      connId,
      auth,
    );
    return yield* buildHelloOk(auth, connId, presenceService);
  }).pipe(Effect.withSpan("connect.completeAgentConnect"));
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

      const connections = yield* ConnectionManagerTag;
      const appAuthService = yield* AppAuthServiceTag;
      const appHost = yield* AppHostTag;
      const presenceService = yield* PresenceServiceTag;
      const conn = yield* ConnectionTag;

      // D #705 CP4d/CP5 — Connect dispatches on the live arm. A re-Connect on
      // an already-authenticated arm is an idempotent no-op that re-emits the
      // arm-appropriate `HelloOk`: the agent arm re-hydrates its agent shape;
      // the app arm re-emits the agentId-less app shape.
      if (conn._tag === "AgentConnection") {
        return yield* buildHelloOk(conn.auth, conn.connId, presenceService);
      }
      if (conn._tag === "AppConnection") {
        return buildAppHelloOk();
      }

      // D #705 CP5 — structural credential dispatch over the Connect params
      // union. The `appKey` arm mints an `AppConnection` (no agent identity,
      // no conversation/presence hydration); the agent/session arms run the
      // full agent-side hydration in `completeAgentConnect`.
      if ("appKey" in params) {
        const { auth: appAuth, manifest } = yield* authenticateAppKey(
          params.appKey,
          appAuthService,
        );
        yield* registerAppArmTransition({
          connections,
          appHost,
          connId: conn.connId,
          auth: appAuth,
          manifest,
        });
        return buildAppHelloOk();
      }

      return yield* completeAgentConnect(params, conn.connId);
    }).pipe(Effect.withSpan("network.connect")),
  );
}

export const connectHandlers: RpcMethodRegistry = [
  // D #705 CP8 — Connect is bound at the APP layer: its `appKey` arm pulls
  // `AppHostTag` to implicitly register the app's `AppEndpoint` off the live
  // `AppConnection` arm (replacing the deleted WS `apps/register` RPC). The
  // agent/session arms ride the same handler and yield no app-layer tags.
  defineAppMethod(Connect, {
    handler: handleConnect,
  }),
];
