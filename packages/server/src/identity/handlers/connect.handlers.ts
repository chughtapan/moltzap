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
  agentContextFrom,
  AgentContext,
  AppContext,
} from "../../transport/context.js";
import {
  AgentEndpointResolverTag,
  AppAuthServiceTag,
  AppHostTag,
  AuthServiceTag,
  ConnectionHooksTag,
  ConnectionTag,
  ConnectionManagerTag,
  ConversationServiceTag,
  DbTag,
  PresenceServiceTag,
} from "../../app/layers.js";
import type { ConnectionId } from "@moltzap/protocol/network";
import type { AgentEndpointResolver } from "../../network/agent-endpoint-resolver.js";
import type { AuthService } from "../../identity/services/auth.service.js";
import { API_KEY_PREFIX, APP_KEY_PREFIX } from "../services/agent-auth.js";
import type { AppAuthService } from "../../identity/services/app-auth.service.js";
import type { PresenceService } from "../../network/services/presence.service.js";
import type { ConversationService } from "../../task/services/conversation.service.js";
import { InvalidParamsError } from "@moltzap/protocol";
import { catchSqlErrorAsDefect } from "../../db/effect-kysely-toolkit.js";
import type {
  ConnectionManager,
  Originator,
} from "../../transport/connection.js";
import type { AppHost } from "../../app/app-host.js";

type ConnectParams = ParamsOf<typeof Connect>;

/** The empty HelloOk — success is the only payload. */
const HELLO_OK: HelloOk = {};

/** Agent API-key path — mints the closed-union `AgentContext` arm directly. */
function authenticateAgentKey(
  agentKey: string,
  authService: AuthService,
): Effect.Effect<AgentContext, UnauthorizedError> {
  return Effect.gen(function* () {
    const agent = yield* authService.authenticateAgent(agentKey);
    if (!agent) {
      return yield* Effect.fail(
        new UnauthorizedError({ message: "Authentication failed" }),
      );
    }
    return yield* agentContextFrom({
      agentId: agent.agentId,
      agentStatus: agent.status,
      ownerUserId: agent.ownerUserId,
    });
  }).pipe(Effect.withSpan("connect.authenticateAgentKey"));
}

/**
 * Emit the agent's `online` presence on connect, then return the empty HelloOk.
 * `onAgentConnect(agentId, connId)` threads `connId` for the fast-reconnect
 * race guard. The handshake carries no agent identity back — the client already
 * holds its registered `agentId`.
 */
function buildHelloOk(
  ctx: AgentContext,
  connId: ConnectionId,
  presenceService: PresenceService,
): Effect.Effect<HelloOk, UnauthorizedError | InvalidParamsError> {
  return Effect.gen(function* () {
    yield* presenceService.onAgentConnect(ctx.agentId, connId);
    return HELLO_OK;
  }).pipe(Effect.withSpan("connect.buildHelloOk"));
}

/**
 * Resolve an `appKey` credential to its `AppContext` AND its
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
 * Register the freshly minted `AppConnection`'s `AppEndpoint` into
 * `AppHost`/`AppRegistry`, then re-peek for a close race.
 *
 *   1. Register `{ connId, originator }` off the live arm via
 *      `AppHost.registerApp`. A `false` return (the registry rejects an
 *      overwrite — another live connection already owns this appId) rolls
 *      the arm back + surfaces the uniform `UnauthorizedError` (the appKey
 *      resolved but its slot is occupied).
 *   2. A close that raced between the transition and the registration
 *      leaves a stale registry entry; undo it via
 *      `unregisterAppsForConnection` before failing `NotConnectedError`.
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
    // Register under the SERVER-MINTED `appId` (the authenticated
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
 * Mint the `AppConnection` arm via the immutable transition AND
 * implicitly register its `AppEndpoint` into `AppHost`/`AppRegistry`. An
 * app's routing surface is now minted from the live `AppConnection` arm on
 * appKey Connect — there is no separate WS `apps/register` RPC. Mirrors
 * {@link mirrorAgentArmTransition}
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
  auth: AgentContext,
  conversationService: ConversationService,
) {
  return Effect.gen(function* () {
    const convIds = yield* conversationService.getConversationIds(auth.agentId);
    // Seed the agent arm's `connectionsRef` subscription set (the fan-out
    // gate reads it). The arm was minted by `mirrorAgentArmTransition` just
    // above, so it exists for this connId.
    yield* connections.hydrateConversationIds(connId, convIds);
  }).pipe(Effect.withSpan("connect.hydrateConnectionState"));
}

function registerEndpointIfStillConnected(
  connections: ConnectionManager,
  resolver: AgentEndpointResolver,
  connId: ConnectionId,
  auth: AgentContext,
) {
  return Effect.gen(function* () {
    // Read the live `connectionsRef` arm before registering the endpoint.
    if (Option.isSome(yield* connections.peek(connId))) {
      yield* resolver.add(auth.agentId, connId);
    }
  }).pipe(Effect.withSpan("connect.registerEndpointIfStillConnected"));
}

/**
 * Mint the agent arm onto the `connectionsRef` via the
 * immutable transition. The `AgentContext` is resolved directly by the
 * authenticators (no `AuthenticatedContext` intermediary), so this passes it
 * straight to `authenticate`. All `TransitionOutcome` arms are matched
 * exhaustively. `not-connected` is a benign race (the close handler removed the
 * entry); `already-connected` is the re-auth no-op (a fresh `HelloOk`).
 */
function mirrorAgentArmTransition(
  connections: ConnectionManager,
  connId: ConnectionId,
  auth: AgentContext,
): Effect.Effect<void> {
  return connections.authenticate(connId, auth).pipe(
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
 * Agent post-auth flow. Resolves the `moltzap_agent_`-prefixed credential to an
 * `AgentContext`, mints the agent arm via the immutable transition, hydrates
 * the conversation-id subscription set + agent-endpoint registration, then
 * emits the empty `HelloOk`. Reached only for the agent-prefixed credential
 * (the app-prefixed credential returns early in {@link handleConnect}).
 */
function completeAgentConnect(credential: string, connId: ConnectionId) {
  return Effect.gen(function* () {
    const authService = yield* AuthServiceTag;
    const conversationService = yield* ConversationServiceTag;
    const presenceService = yield* PresenceServiceTag;
    const connections = yield* ConnectionManagerTag;
    const agentEndpointResolver = yield* AgentEndpointResolverTag;

    const auth = yield* authenticateAgentKey(credential, authService);
    // The agent arm is minted by the immutable transition below; the
    // arm IS the auth store.
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
    const helloOk = yield* buildHelloOk(auth, connId, presenceService);
    yield* fireConnectionHooks(auth, connId);
    return helloOk;
  }).pipe(Effect.withSpan("connect.completeAgentConnect"));
}

/**
 * Fire every registered connection hook for a freshly-authenticated agent arm.
 * Hooks carry `agentId`, the agent's display name (DB lookup, falling back to
 * the id), `ownerUserId`, and `connId`. Each runs with a 2-second timeout;
 * a throw or timeout is logged and does not fail the Connect.
 */
function fireConnectionHooks(auth: AgentContext, connId: ConnectionId) {
  return Effect.gen(function* () {
    const hooks = yield* ConnectionHooksTag;
    if (hooks.connectionHooks.length === 0) return;
    const db = yield* DbTag;
    const row = yield* Effect.tryPromise(() =>
      db
        .selectFrom("agents")
        .select("name")
        .where("id", "=", auth.agentId)
        .executeTakeFirst(),
    ).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    const agentName = row?.name ?? auth.agentId;
    for (const hook of hooks.connectionHooks) {
      yield* Effect.tryPromise({
        try: () =>
          Promise.resolve(
            hook({
              agentId: auth.agentId,
              agentName,
              ownerUserId: auth.ownerUserId,
              connId,
            }),
          ),
        catch: (err) => err,
      }).pipe(
        Effect.timeoutFail({
          duration: "2 seconds",
          onTimeout: () => new Error("Connection hook timed out"),
        }),
        Effect.catchAll((err) =>
          Effect.logWarning("Connection hook error").pipe(
            Effect.annotateLogs({ err, agentId: auth.agentId, connId }),
          ),
        ),
      );
    }
  }).pipe(Effect.withSpan("connect.fireConnectionHooks"));
}

/**
 * Prefix-resolve the single `credential` on the unauthenticated arm:
 * `moltzap_app_` mints an `AppConnection` (no agent identity, no
 * conversation/presence hydration); `moltzap_agent_` runs the full agent-side
 * hydration; neither prefix is `UnauthorizedError`. The prefix is the principal
 * selector — an app credential can never mint an agent arm and vice versa.
 */
function resolveCredential(
  credential: string,
  connId: ConnectionId,
  deps: {
    readonly connections: ConnectionManager;
    readonly appAuthService: AppAuthService;
    readonly appHost: AppHost;
  },
): Effect.Effect<
  HelloOk,
  UnauthorizedError | NotConnectedError | InvalidParamsError,
  | AuthServiceTag
  | ConversationServiceTag
  | PresenceServiceTag
  | ConnectionManagerTag
  | AgentEndpointResolverTag
  | ConnectionHooksTag
  | DbTag
> {
  return Effect.gen(function* () {
    if (credential.startsWith(APP_KEY_PREFIX)) {
      const { auth: appAuth, manifest } = yield* authenticateAppKey(
        credential,
        deps.appAuthService,
      );
      yield* registerAppArmTransition({
        connections: deps.connections,
        appHost: deps.appHost,
        connId,
        auth: appAuth,
        manifest,
      });
      return HELLO_OK;
    }
    if (credential.startsWith(API_KEY_PREFIX)) {
      return yield* completeAgentConnect(credential, connId);
    }
    return yield* Effect.fail(
      new UnauthorizedError({
        message: "Credential has no recognized principal prefix",
      }),
    );
  }).pipe(Effect.withSpan("connect.resolveCredential"));
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

      // Connect dispatches on the live arm. A re-Connect on an
      // already-authenticated arm is an idempotent no-op that re-emits the
      // empty HelloOk.
      if (conn._tag === "AgentConnection") {
        const helloOk = yield* buildHelloOk(
          conn.auth,
          conn.connId,
          presenceService,
        );
        yield* fireConnectionHooks(conn.auth, conn.connId);
        return helloOk;
      }
      if (conn._tag === "AppConnection") {
        return HELLO_OK;
      }

      return yield* resolveCredential(params.credential, conn.connId, {
        connections,
        appAuthService,
        appHost,
      });
    }).pipe(Effect.withSpan("network.connect")),
  );
}

// ── Native @effect/rpc handler body ─────────────────────────────────────────
//
// `network/connect` is the lone unauthenticated method: it carries no `*Auth`
// proof. The body dispatches on the credential union itself, reading the live
// `UnauthenticatedConnection` arm via `ConnectionTag`. Its domain errors map to
// the coded wire envelope the engine member's `error` schema carries.
export const nativeConnect = (params: ConnectParams) =>
  handleConnect(params).pipe(
    Effect.withSpan("nativeConnect"),
  );
