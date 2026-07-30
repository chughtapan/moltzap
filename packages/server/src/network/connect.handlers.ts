// safer-arch-ignore no-cross-domain-sibling-import: The connection handshake is an adapter boundary that authenticates principals and registers their domain services atomically.
import { Data, Effect, Match, Option } from "effect";
import {
  type agentConnect,
  type appConnect,
  PROTOCOL_VERSION,
  checkProtocolRange,
  type HelloOk,
} from "@moltzap/protocol/network";
import {
  UnauthorizedError,
  type ParamsOf,
  InvalidParamsError,
} from "@moltzap/protocol/rpc";
import type { AgentKey, AppKey, AppManifest } from "@moltzap/protocol/identity";
import type { ServerHandler } from "@moltzap/protocol/socket/catalog";
import {
  agentContextFrom,
  type AgentContext,
  type AppContext,
  ConnectionManagerTag,
  ConnectionTag,
  type Connection,
  type ConnectionManager,
  type Originator,
} from "#socket";
import { ConnectionHooksTag } from "../core/hooks.js";
import { DbTag, catchSqlErrorAsDefect } from "#db";
import { AuthServiceTag } from "../identity/agents/layer.js";
import type { AuthService } from "../identity/agents/auth.service.js";
import {
  AppAuthServiceTag,
  AppEndpointRegistryTag,
} from "../identity/apps/layer.js";
import type { AppAuthService } from "../identity/apps/auth.service.js";
import type { AppEndpointRegistry } from "../identity/apps/endpoint-registry.js";
import { ConversationServiceTag } from "../conversation/layer.js";
import type { ConversationService } from "../conversation/conversation.service.js";
import { AgentEndpointResolverTag } from "./layer.js";
import { PresenceServiceTag } from "./presence/layer.js";
import type { PresenceService } from "./presence/presence.service.js";
import type { ConnectionId } from "@moltzap/protocol/socket";
import type { AgentEndpointResolver } from "./agent-endpoint-resolver.js";

type AgentConnectParams = ParamsOf<typeof agentConnect>;
type AppConnectParams = ParamsOf<typeof appConnect>;
type ConnectParams = AgentConnectParams | AppConnectParams;

/** The empty HelloOk — success is the only payload. */
const HELLO_OK: HelloOk = {};

class ConnectionHookError extends Data.TaggedError("ConnectionHookError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Agent API-key path — mints the closed-union `AgentContext` arm directly.
 * @param agentKey Value supplied to the operation.
 * @param authService Value supplied to the operation.
 * @returns The authenticate agent key result.
 */
function authenticateAgentKey(
  agentKey: AgentKey,
  authService: AuthService,
): Effect.Effect<AgentContext, UnauthorizedError> {
  return Effect.gen(function* () {
    const agent = yield* authService.authenticateAgent(agentKey);
    if (!agent) {
      return yield* new UnauthorizedError({ message: "Authentication failed" });
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
 * @param ctx Context for the operation.
 * @param connId Value supplied to the operation.
 * @param presenceService Value supplied to the operation.
 * @returns The created hello ok.
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
 * @param appKey Value supplied to the operation.
 * @param appAuthService Value supplied to the operation.
 * @returns The authenticate app key result.
 */
function authenticateAppKey(
  appKey: AppKey,
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
 * `AppEndpointRegistry`/`AppRegistry`, then re-peek for a close race.
 *
 *   1. Register `{ connId, originator }` off the live arm via
 *      `AppEndpointRegistry.registerApp`. A `false` return (the registry rejects an
 *      overwrite — another live connection already owns this appId) rolls
 *      the arm back + surfaces the uniform `UnauthorizedError` (the appKey
 *      resolved but its slot is occupied).
 *   2. A close that raced between the transition and the registration
 *      leaves a stale registry entry; undo it via
 *      `unregisterAppsForConnection` before interrupting the closed request.
 * @param args Value supplied to the operation.
 * @param args.connections Value supplied to the operation.
 * @param args.appEndpointRegistry Value supplied to the operation.
 * @param args.appId Value supplied to the operation.
 * @param args.manifest Value supplied to the operation.
 * @param args.authed Value supplied to the operation.
 * @param args.authed.connId Value supplied to the operation.
 * @param args.authed.originator Value supplied to the operation.
 * @returns The register app endpoint result.
 */
function registerAppEndpoint(args: {
  readonly connections: ConnectionManager;
  readonly appEndpointRegistry: AppEndpointRegistry;
  readonly appId: AppContext["appId"];
  readonly manifest: AppManifest;
  readonly authed: {
    readonly connId: ConnectionId;
    readonly originator: Originator;
  };
}): Effect.Effect<void, UnauthorizedError> {
  const { connections, appEndpointRegistry, appId, manifest, authed } = args;
  const connId = authed.connId;
  return Effect.gen(function* () {
    // Register under the SERVER-MINTED `appId` (the authenticated
    // principal), NOT `manifest.appId`. `agent/task/request` routes to the appId the
    // registrant received from `/api/v1/apps/register` = this identity.
    const ok = appEndpointRegistry.registerApp(appId, manifest, {
      connId,
      originator: authed.originator,
    });
    if (!ok) {
      yield* connections.rollbackToUnauthenticated(connId);
      return yield* new UnauthorizedError({
        message: `App ${appId} already has an active connection`,
      });
    }
    const postCheck = yield* connections.peek(connId);
    if (Option.isNone(postCheck)) {
      appEndpointRegistry.unregisterAppsForConnection(connId);
      return yield* Effect.interrupt;
    }
    if (postCheck.value._tag !== "AppConnection") {
      appEndpointRegistry.unregisterAppsForConnection(connId);
      return yield* Effect.dieMessage(
        "registerAppEndpoint: app authentication produced a non-app connection",
      );
    }
  }).pipe(Effect.withSpan("connect.registerAppEndpoint"));
}

/**
 * Mint the `AppConnection` arm via the immutable transition AND
 * implicitly register its `AppEndpoint` into `AppEndpointRegistry`/`AppRegistry`. An
 * app's routing surface is minted from the live `AppConnection` arm on
 * appKey Connect. Mirrors
 * {@link mirrorAgentArmTransition}
 * for the app principal; all `TransitionOutcome` arms are matched exhaustively:
 * `ok-app` registers the endpoint (see {@link registerAppEndpoint}); `ok-agent`
 * is impossible here (we pass an `AppContext`) — `Effect.die`;
 * `already-connected` is the re-auth no-op (HelloOk re-emitted upstream);
 * `not-connected` is a benign close race.
 * @param args Value supplied to the operation.
 * @param args.connections Value supplied to the operation.
 * @param args.appEndpointRegistry Value supplied to the operation.
 * @param args.connId Value supplied to the operation.
 * @param args.auth Value supplied to the operation.
 * @param args.manifest Value supplied to the operation.
 * @returns The register app arm transition result.
 */
function registerAppArmTransition(args: {
  readonly connections: ConnectionManager;
  readonly appEndpointRegistry: AppEndpointRegistry;
  readonly connId: ConnectionId;
  readonly auth: AppContext;
  readonly manifest: AppManifest;
}): Effect.Effect<void, UnauthorizedError> {
  const { connections, appEndpointRegistry, connId, auth, manifest } = args;
  return connections.authenticate(connId, auth).pipe(
    Effect.flatMap((outcome) =>
      Match.value(outcome).pipe(
        Match.when({ kind: "ok-app" }, ({ authed }) =>
          registerAppEndpoint({
            connections,
            appEndpointRegistry,
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
    // Seed the agent arm's conversation membership cache. The arm was minted
    // by `mirrorAgentArmTransition` just above, so it exists for this connId.
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
 * @param connections Value supplied to the operation.
 * @param connId Value supplied to the operation.
 * @param auth Value supplied to the operation.
 * @returns The mirror agent arm transition result.
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
 * @param credential Value supplied to the operation.
 * @param connId Value supplied to the operation.
 * @returns The complete agent connect result.
 */
function completeAgentConnect(credential: AgentKey, connId: ConnectionId) {
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
 * @param auth Value supplied to the operation.
 * @param connId Value supplied to the operation.
 * @returns The fire connection hooks result.
 */
function fireConnectionHooks(auth: AgentContext, connId: ConnectionId) {
  return Effect.gen(function* () {
    const hooks = yield* ConnectionHooksTag;
    if (hooks.connectionHooks.length === 0) {
      return;
    }
    const db = yield* DbTag;
    const row = yield* Effect.tryPromise(() =>
      db
        .selectFrom("agents")
        .select("name")
        .where("id", "=", auth.agentId)
        .executeTakeFirst(),
    ).pipe(Effect.orElseSucceed(() => undefined));
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
        catch: (cause) =>
          new ConnectionHookError({
            message: "Connection hook failed",
            cause,
          }),
      }).pipe(
        Effect.timeoutFail({
          duration: "2 seconds",
          onTimeout: () =>
            new ConnectionHookError({ message: "Connection hook timed out" }),
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

function checkConnectProtocol(params: ConnectParams) {
  // Protocol-range gate runs BEFORE auth resolution: clients outside the
  // supported version range are rejected at the version edge, so no partial
  // state leaks before the rejection. A malformed `min/maxProtocol` string
  // maps to the wire-typed `InvalidParamsError` (JSON-RPC -32602).
  return checkProtocolRange(params, PROTOCOL_VERSION).pipe(
    Effect.catchTag("InvalidProtocolVersionError", (cause) =>
      Effect.fail(
        new InvalidParamsError({
          message: `Malformed protocol version ${JSON.stringify(cause.version)}: invalid segment ${JSON.stringify(cause.segment)}`,
        }),
      ),
    ),
  );
}

function reemitHelloIfAuthenticated(
  conn: Connection,
  presenceService: PresenceService,
) {
  return Effect.gen(function* () {
    if (conn._tag === "AgentConnection") {
      const helloOk = yield* buildHelloOk(
        conn.auth,
        conn.connId,
        presenceService,
      );
      yield* fireConnectionHooks(conn.auth, conn.connId);
      return Option.some(helloOk);
    }
    if (conn._tag === "AppConnection") {
      return Option.some(HELLO_OK);
    }
    return Option.none<HelloOk>();
  }).pipe(Effect.withSpan("connect.reemitHelloIfAuthenticated"));
}

/**
 * Shared Connect preamble for both principal paths: gate the protocol range,
 * then re-emit `HelloOk` for an already-authenticated arm (idempotent re-auth).
 * Returns the live connection plus `Some(helloOk)` when the caller short-
 * circuits, `None` when it should run its principal-specific auth.
 * @param params Request payload to process.
 * @returns The connect preamble result.
 */
function connectPreamble(params: ConnectParams) {
  return Effect.gen(function* () {
    yield* checkConnectProtocol(params);
    const presenceService = yield* PresenceServiceTag;
    const conn = yield* ConnectionTag;
    const reemitted = yield* reemitHelloIfAuthenticated(conn, presenceService);
    return { conn, reemitted };
  });
}

function handleAgentConnect(params: AgentConnectParams) {
  return catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const { conn, reemitted } = yield* connectPreamble(params);
      if (Option.isSome(reemitted)) {
        return reemitted.value;
      }

      return yield* completeAgentConnect(params.agentKey, conn.connId);
    }).pipe(Effect.withSpan("agent.connect")),
  );
}

function handleAppConnect(params: AppConnectParams) {
  return catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const { conn, reemitted } = yield* connectPreamble(params);
      if (Option.isSome(reemitted)) {
        return reemitted.value;
      }

      const connections = yield* ConnectionManagerTag;
      const appAuthService = yield* AppAuthServiceTag;
      const appEndpointRegistry = yield* AppEndpointRegistryTag;
      const { auth: appAuth, manifest } = yield* authenticateAppKey(
        params.appKey,
        appAuthService,
      );
      yield* registerAppArmTransition({
        connections,
        appEndpointRegistry,
        connId: conn.connId,
        auth: appAuth,
        manifest,
      });
      return HELLO_OK;
    }).pipe(Effect.withSpan("app.connect")),
  );
}

// ── @effect/rpc handler bodies ────────────────────────────────────────
//
// `agent/network/connect` and `app/network/connect` are the unauthenticated methods. The
// method tag selects the principal kind; the body only unwraps the redacted
// key at the auth-service boundary.
/**
 * Provides the connect agent runtime value.
 * @param params Request payload to process.
 * @returns The connect agent result.
 */
export const connectAgent: ServerHandler<typeof agentConnect> = (params) =>
  handleAgentConnect(params).pipe(Effect.withSpan("connect.agent"));

/**
 * Provides the connect app runtime value.
 * @param params Request payload to process.
 * @returns The connect app result.
 */
export const connectApp: ServerHandler<typeof appConnect> = (params) =>
  handleAppConnect(params).pipe(Effect.withSpan("connect.app"));

// safer-arch-ignore no-fat-orchestrator: Connect handlers coordinate authentication, connection-arm transitions, endpoint registration, and presence as one atomic handshake boundary.
