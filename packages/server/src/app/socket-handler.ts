/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import * as Socket from "@effect/platform/Socket";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Layer,
  Mailbox,
  type Scope,
} from "effect";
import type { ChannelSink } from "@moltzap/protocol";
import { runMuxReader } from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";
import { acquireConnectionRpcClient } from "../transport/connection.js";
import { makeSocketEngineLayer } from "../transport/native-server-wiring.js";

import type { AgentContext } from "../transport/context.js";
import { connectionId as brandConnectionId } from "../network/agent-endpoint-resolver.js";
import type { AppTags } from "../transport/layer-tags.js";
import type { ConnectionTag, ResolvedServices } from "./layers.js";
import type { ConnectionHook, DisconnectionHook } from "./types.js";

type SocketWrite = (raw: string) => Effect.Effect<void, Socket.SocketError>;

interface SocketHandlerOptions {
  readonly services: Pick<
    ResolvedServices,
    | "db"
    | "connections"
    | "agentEndpointResolver"
    | "presenceService"
    | "leaseRegistry"
    | "appHost"
  >;
  readonly connectionHooks: readonly ConnectionHook[];
  readonly disconnectionHooks: readonly DisconnectionHook[];
}

interface SocketSession {
  readonly connId: ConnectionId;
  readonly write: SocketWrite;
  readonly closeRequested: Deferred.Deferred<void>;
}

/**
 * Build the handler that the `/ws` route hands the upgraded socket to. Each
 * connection runs as one scoped Effect: the connection scope owns the
 * per-socket native `@effect/rpc` engine, the `ConnectionManager` entry, the
 * per-connection RPC originator (server→client appCallback path, until 3c),
 * and every cleanup hook.
 *
 * The inbound path is the native engine: `makeSocketEngineLayer` stands one
 * `RpcServer<WsServerEngineRpcGroup>` per socket (the per-method `*AuthMw`
 * gate + the per-socket `ConnectionTag` + the `c2s` mux Protocol), built into
 * the connection scope so its dispatch loop runs. `runMuxReader` drives the
 * socket read loop, routing each `{ch,f}` envelope to the engine's `c2s`
 * sink; a non-envelope chunk is dropped after a warning (`routeInbound`).
 *
 * ```mermaid
 * sequenceDiagram
 *   participant C as Client
 *   participant WS as /ws route
 *   participant HS as openSocketSession
 *   participant ENG as per-socket RpcServer engine
 *   participant R as runMuxReader fiber
 *   participant CM as ConnectionManager
 *   participant Cleanup as onExit
 *
 *   C->>WS: GET /ws Upgrade
 *   WS->>HS: socket
 *   Note over HS: connId = randomUUID<br>writer + closeRequested + disconnects Mailbox + sinkReady Deferred
 *   HS->>CM: connections.addUnauthenticated{connId, socket, originator}
 *   HS->>ENG: Layer.build(makeSocketEngineLayer) into the connection scope
 *   Note over ENG: dispatch loop forked; Protocol fulfils the c2s sink
 *   HS->>R: runMuxReader(socket, {c2s sink}, disconnects)
 *   C->>R: {ch:c2s, f: connect frame}
 *   R->>ENG: routeInbound → sink.inject → engine write
 *   Note over ENG: *AuthMw gate → native handler → reply over c2s
 *   R-->>Cleanup: socket closes → disconnects.offer
 *   Note over Cleanup: removeAndReturn(connId) → agent-disconnect cleanup<br>disconnection hooks → resolver/lease/presence/appHost teardown
 * ```
 *
 * `Effect.raceFirst` (vs plain `race`) is load-bearing: an abrupt disconnect
 * still propagates as an interruption that triggers `onExit`. Plain `race`
 * would leak resources on abnormal close. Disconnection hooks run
 * SEQUENTIALLY so each hook's cleanup completes before the next observes
 * post-close state.
 */
export function makeSocketHandler(options: SocketHandlerOptions) {
  return (
    socket: Socket.Socket,
  ): Effect.Effect<void, Socket.SocketError, Exclude<AppTags, ConnectionTag>> =>
    Effect.scoped(openSocketSession(socket, options));
}

function openSocketSession(
  socket: Socket.Socket,
  options: SocketHandlerOptions,
) {
  return Effect.gen(function* () {
    const session = yield* makeSocketSession(socket);
    // The per-connection originator carries the server→client appCallback
    // outbound path (the `s2c` channel inverts at 3c). The inbound dispatcher
    // is the native engine below, not the originator's slot table — the
    // originator is built with an empty slot table.
    const serverConn = yield* acquireConnectionRpcClient(
      session.connId,
      session.write,
    );
    const shutdown = Deferred.succeed(session.closeRequested, undefined).pipe(
      Effect.asVoid,
    );
    yield* options.services.connections.addUnauthenticated(
      session.connId,
      { write: session.write, shutdown },
      serverConn,
    );
    yield* Effect.logInfo("WebSocket connected").pipe(
      Effect.annotateLogs({ connId: session.connId }),
    );

    // Stand the per-socket native engine inside this connection's scope. The
    // `write` injector is the raw socket writer; the engine's c2s Protocol
    // fulfils `sinkReady` with the channel sink `runMuxReader` routes into.
    const disconnects = yield* Mailbox.make<number>();
    const sinkReady = yield* Deferred.make<ChannelSink>();
    yield* Layer.build(
      makeSocketEngineLayer({
        connId: session.connId,
        write: session.write,
        disconnects,
        sinkReady,
      }),
    );
    const sink = yield* Deferred.await(sinkReady);

    // Route both channels: c2s into the inbound engine's sink, s2c into the
    // reverse client's sink (the void-acks for the server's
    // callback/notification RPCs).
    const reader = runMuxReader(
      socket,
      { c2s: sink, s2c: serverConn.sink },
      disconnects,
    );
    yield* runSocketReader(reader, session, options);
  }).pipe(Effect.withSpan("socket.openSession"));
}

function makeSocketSession(
  socket: Socket.Socket,
): Effect.Effect<SocketSession, never, Scope.Scope> {
  return Effect.gen(function* () {
    // Single boundary brand at the WS-accept mint site:
    // `crypto.randomUUID()` returns `string`; `brandConnectionId` encapsulates
    // the only acceptable cast in production. Every downstream service
    // receives the brand-typed id.
    const connId = brandConnectionId(crypto.randomUUID());
    const writer = yield* socket.writer;
    const closeRequested = yield* Deferred.make<void>();
    const write: SocketWrite = (raw) => writer(raw);
    return { connId, write, closeRequested };
  }).pipe(Effect.withSpan("socket.makeSession"));
}

function runSocketReader<R>(
  reader: Effect.Effect<void, Socket.SocketError, R>,
  session: SocketSession,
  options: SocketHandlerOptions,
) {
  return Effect.raceFirst(reader, Deferred.await(session.closeRequested)).pipe(
    Effect.onExit((exit) => closeSocketSession(exit, session, options)),
  );
}

function closeSocketSession(
  exit: Exit.Exit<void, Socket.SocketError>,
  session: SocketSession,
  options: SocketHandlerOptions,
) {
  return Effect.gen(function* () {
    // Atomic delete + return of the live arm drives the auth-gated cleanup.
    // The agent arm carries the `AgentContext`; the app + unauthenticated arms
    // skip the agent-disconnect path.
    const removed = yield* options.services.connections.removeAndReturn(
      session.connId,
    );
    if (removed !== undefined && removed._tag === "AgentConnection") {
      const authCtx = removed.auth;
      // Emit `offline` via onAgentDisconnect(agentId, connId). connId is
      // threaded for the fast-reconnect race guard — the entry is dropped only
      // if connId is in liveConns (else silent no-op for stale-session
      // disconnects). Runs BEFORE leaseRegistry.abandon so subsequent lease
      // callbacks find the connId gone (audit at debug, no emission).
      yield* options.services.presenceService.onAgentDisconnect(
        authCtx.agentId,
        session.connId,
      );
      yield* runDisconnectionHooks(authCtx, session, options);
      yield* options.services.agentEndpointResolver.remove(
        authCtx.agentId,
        session.connId,
      );
    }
    yield* options.services.leaseRegistry.abandon(session.connId);
    options.services.presenceService.removeConnection(session.connId);
    options.services.appHost.unregisterAppsForConnection(session.connId);
    if (Exit.isFailure(exit)) {
      yield* Effect.logWarning("WebSocket error").pipe(
        Effect.annotateLogs({
          connId: session.connId,
          cause: Cause.pretty(exit.cause),
        }),
      );
    }
    yield* Effect.logInfo("WebSocket disconnected").pipe(
      Effect.annotateLogs({ connId: session.connId }),
    );
  }).pipe(Effect.withSpan("socket.closeSession"));
}

function runDisconnectionHooks(
  authCtx: AgentContext,
  session: SocketSession,
  options: SocketHandlerOptions,
) {
  return Effect.gen(function* () {
    const { agentId, ownerUserId } = authCtx;
    for (const hook of options.disconnectionHooks) {
      yield* runUserHook(
        hook,
        { agentId, ownerUserId, connId: session.connId },
        "Disconnection hook",
        { agentId, connId: session.connId },
      );
    }
  }).pipe(Effect.withSpan("socket.runDisconnectionHooks"));
}

function runUserHook<TArgs>(
  hook: (args: TArgs) => void | PromiseLike<void>,
  args: TArgs,
  label: string,
  logCtx: Record<string, unknown>,
): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => Promise.resolve(hook(args)),
    catch: (err) => err,
  }).pipe(
    Effect.timeoutFail({
      duration: "2 seconds",
      onTimeout: () => new Error(`${label} timed out`),
    }),
    Effect.catchAll((err) =>
      Effect.logWarning(`${label} error`).pipe(
        Effect.annotateLogs({ err, ...logCtx }),
      ),
    ),
  );
}

export { runUserHook };
