/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import * as Socket from "@effect/platform/Socket";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Match,
  Option,
  type Scope,
} from "effect";
import type { JsonRpcId, RequestFrame, ResponseFrame } from "@moltzap/protocol";
import {
  Connect,
  JSON_RPC_RESERVED_CODES,
  UnauthorizedError,
  decodeClientInbound,
  encodeErrorResponse,
} from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";
import { acquireConnectionRpcClient } from "../transport/connection.js";

import type { AgentContext } from "../transport/context.js";
import type { ServerRpcSlotTable } from "../transport/context.js";
import { connectionId as brandConnectionId } from "../network/agent-endpoint-resolver.js";
import type { AppTags } from "../transport/layer-tags.js";
import type { ConnectionTag, ResolvedServices } from "./layers.js";
import type { ConnectionHook, DisconnectionHook } from "./types.js";
const ERROR_INVALID_JSON = "Invalid JSON";

const UTF8_DECODER = new TextDecoder("utf-8");
const MALFORMED_LOG_EVERY = 50;

type SocketWrite = (raw: string) => Effect.Effect<void, Socket.SocketError>;
type SendFrame = (obj: unknown) => Effect.Effect<void>;

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
  readonly slots: ServerRpcSlotTable;
  readonly connectionHooks: readonly ConnectionHook[];
  readonly disconnectionHooks: readonly DisconnectionHook[];
}

interface SocketSession {
  readonly connId: ConnectionId;
  readonly write: SocketWrite;
  readonly sendFrame: SendFrame;
  readonly closeRequested: Deferred.Deferred<void>;
  readonly malformedFrames: { count: number };
}

/**
 * Build the handler that the `/ws` route hands the upgraded socket
 * to. Each connection runs as one scoped Effect: the connection
 * scope owns the per-connection RPC originator, the
 * `ConnectionManager` entry, and every cleanup hook.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant C as Client
 *   participant WS as /ws route
 *   participant HS as handleSocket (this)
 *   participant RPC as acquireConnectionRpcClient
 *   participant CM as ConnectionManager
 *   participant R as socket reader fiber
 *   participant Cleanup as onExit
 *
 *   C->>WS: GET /ws Upgrade
 *   WS->>HS: socket
 *   Note over HS: connId = randomUUID<br>writer + closeRequested Deferred
 *   HS->>RPC: acquireConnectionRpcClient(connId, write)
 *   Note over RPC: per-connection originator<br>scope-bound finalizer fails pending Deferreds with NotConnectedError
 *   RPC-->>HS: originator
 *   HS->>CM: connections.addUnauthenticated{connId, socket, originator}
 *   HS->>R: socket.runRaw — handleFrame
 *   Note over HS,R: Effect.raceFirst(reader, Deferred.await(closeRequested))<br>raceFirst, not race — abrupt close still runs onExit
 *   R-->>Cleanup: socket closes
 *   Note over Cleanup: removed = connections.removeAndReturn(connId)<br>if AgentConnection → presenceService.onAgentDisconnect(agentId, connId)<br>for hook of disconnectionHooks — runUserHook sequentially<br>agentEndpointResolver.remove(agentId, connId)<br>leaseRegistry.abandon(connId)<br>presenceService.removeConnection<br>appHost.unregisterAppsForConnection(connId)
 * ```
 *
 * `Effect.raceFirst` (vs plain `race`) is load-bearing: an abrupt
 * disconnect still propagates as an interruption that triggers
 * `onExit`. Plain `race` would leak resources on abnormal close.
 *
 * Disconnection hooks run SEQUENTIALLY so each hook's cleanup
 * completes before the next observes post-close state.
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
    // Spec F (#617) §6 FRI cutover: one `ServerConnection` per socket.
    // Carries BOTH the inbound dispatcher (the static handler table from
    // `createCoreApp`) AND the outbound originator (server→client
    // appCallback path). The `id` mirrors the connId so logs trace
    // request ids back to the originating socket.
    const serverConn = yield* acquireConnectionRpcClient(
      session.connId,
      session.write,
      options.slots,
    );
    const shutdown = Deferred.succeed(session.closeRequested, undefined).pipe(
      Effect.asVoid,
    );
    // D #705 — insert the fresh `UnauthenticatedConnection` arm into the
    // three-arm `connectionsRef` (the only connections map; the legacy
    // `MoltZapConnection` map was deleted at CP4f). The `socket: WebSocketRef`
    // arm carries the write/shutdown surface; `Connect` promotes the arm to
    // agent/app in place via `authenticate`.
    yield* options.services.connections.addUnauthenticated(
      session.connId,
      { write: session.write, shutdown },
      serverConn,
    );
    yield* Effect.logInfo("WebSocket connected").pipe(
      Effect.annotateLogs({ connId: session.connId }),
    );
    const reader = socket.runRaw((data) =>
      handleSocketData(data, session, options),
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
    return {
      connId,
      write,
      closeRequested,
      sendFrame: makeSendFrame(connId, write),
      malformedFrames: { count: 0 },
    };
  }).pipe(Effect.withSpan("socket.makeSession"));
}

function makeSendFrame(connId: ConnectionId, write: SocketWrite): SendFrame {
  return (obj) =>
    write(JSON.stringify(obj)).pipe(
      Effect.catchAll((err) =>
        Effect.logWarning("socket write failed").pipe(
          Effect.annotateLogs({ err, connId }),
        ),
      ),
    );
}

function handleSocketData(
  data: string | Uint8Array,
  session: SocketSession,
  options: SocketHandlerOptions,
) {
  const raw = typeof data === "string" ? data : UTF8_DECODER.decode(data);
  return handleFrame(raw, session, options);
}

/**
 * Per-frame server-side flow: parse, decode, route by tag, hand off
 * to the typed dispatcher, project the `Exit` into a wire response,
 * and fire connection hooks after a successful Connect.
 *
 * ```mermaid
 * flowchart TD
 *   A[raw string from socket] -->|JSON.parse| B{parse ok?}
 *   B -- fail --> Bx[handleParseFailure rate-limited log<br>+ sendFrame ParseError -32700]
 *   B -- ok --> C[decodeClientInbound]
 *   C -- MalformedFrameError --> Cx[sendInvalidRequest null]
 *   C -- ok --> D[Match.value decoded]
 *   D -- ResponseSuccess or ResponseError --> E[conn.originator.resolve frame<br>matches pending Deferred from prior call out]
 *   D -- Notification --> Dx[sendInvalidRequest null — server rejects notifications]
 *   D -- ClientRequest --> F{conn found?}
 *   F -- no --> Fx[return]
 *   F -- yes --> Fa{isConnect or conn.auth?}
 *   Fa -- not authenticated --> FaX[sendFrame Unauthorized -32001]
 *   Fa -- ok --> G[conn.originator.handle frame, ctx auth+connId<br>indexes the ErasedSlotTable by frame.method]
 *   G --> H{Exit?}
 *   H -- success --> Hs[successResponse → sendFrame]
 *   H -- tagged failure --> Ht[knownWireErrorResponse → sendFrame]
 *   H -- untagged --> Hu[internalErrorResponse -32603 → sendFrame]
 *   Hs --> I{isConnect?}
 *   Ht --> I
 *   Hu --> I
 *   I -- yes --> J[fireConnectionHooks — agentName lookup<br>USER_HOOK_TIMEOUT_MS 2_000 per hook]
 *   I -- no --> Done[done]
 * ```
 *
 * Wrapper-owned concerns (not the dispatcher's):
 *
 * - Parse failure with rate-limited logging + `-32700` reply.
 * - `MalformedFrameError → sendInvalidRequest(null)`.
 * - "Must be authenticated before non-Connect RPC" gate.
 * - `Exit → wire frame` projection (success / tagged-error /
 *   internal).
 * - `fireConnectionHooks` after a successful Connect.
 *
 * `conn.originator.handle(frame, ctx)` indexes the kind's
 * `ErasedSlotTable` by `frame.method` (see
 * `@moltzap/protocol transport/dispatch.ts → makeInboundDispatch`). The
 * matched slot decodes params via its OWN validator, runs the #720 gate
 * + the binding's `weaveCaps` capability chain (each declared capability
 * discharged INSIDE the slot via a static per-arm
 * `provideServiceEffect`), and provides `ConnectionTag` /
 * `CurrentPrincipal` around the arm — only the service `Env` rides out.
 * Every slot is required by construction; a method absent at the type
 * level fails compilation at slot-table construction.
 *
 * The originator's pending-map is keyed by frame id. `ResponseFrame`
 * routing is `pendingRef.modify(takePendingEntry(id))` — atomic
 * Get-then-Remove. Late frames (deferred already cleaned up) return
 * `None` and drop harmlessly.
 */
function handleFrame(
  raw: string,
  session: SocketSession,
  options: SocketHandlerOptions,
) {
  return Effect.gen(function* () {
    if (Option.isNone(yield* options.services.connections.peek(session.connId)))
      return;
    const parsed = yield* parseFrame(raw, session);
    if (parsed === null) return;
    yield* decodeClientInbound(parsed).pipe(
      Effect.flatMap((decoded) =>
        Match.value(decoded).pipe(
          Match.tag("ResponseSuccess", ({ frame }) =>
            handleResponseFrame(frame, session, options),
          ),
          Match.tag("ResponseError", ({ frame }) =>
            handleResponseFrame(frame, session, options),
          ),
          Match.tag("Notification", () => sendInvalidRequest(session)),
          Match.tag("ClientRequest", ({ frame }) =>
            handleRequestFrame(frame, session, options),
          ),
          Match.exhaustive,
        ),
      ),
      Effect.catchTag("MalformedFrameError", () => sendInvalidRequest(session)),
    );
  }).pipe(Effect.withSpan("socket.handleFrame"));
}

function parseFrame(
  raw: string,
  session: SocketSession,
): Effect.Effect<unknown | null> {
  return Effect.try({
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) => cause,
  }).pipe(Effect.catchAll((err) => handleParseFailure(err, session)));
}

function handleParseFailure(
  err: unknown,
  session: SocketSession,
): Effect.Effect<null> {
  return Effect.gen(function* () {
    const count = session.malformedFrames.count + 1;
    session.malformedFrames.count = count;
    if (count === 1 || count % MALFORMED_LOG_EVERY === 0) {
      yield* Effect.logWarning("Failed to parse WebSocket frame").pipe(
        Effect.annotateLogs({ err, connId: session.connId, count }),
      );
    }
    yield* session.sendFrame(
      encodeErrorResponse(null, {
        code: JSON_RPC_RESERVED_CODES.ParseError,
        message: ERROR_INVALID_JSON,
      }),
    );
    return null;
  }).pipe(Effect.withSpan("socket.handleParseFailure"));
}

function handleResponseFrame(
  frame: ResponseFrame,
  session: SocketSession,
  options: SocketHandlerOptions,
) {
  return Effect.gen(function* () {
    if (frame.id === null) return;
    const arm = yield* options.services.connections.peek(session.connId);
    if (Option.isNone(arm)) return;
    const matched = yield* arm.value.originator.resolve(frame);
    if (!matched) {
      const responseId = frame.id;
      yield* Effect.logWarning(
        "no pending appCallback request matched inbound response",
      ).pipe(Effect.annotateLogs({ connId: session.connId, id: responseId }));
    }
  }).pipe(Effect.withSpan("socket.handleResponseFrame"));
}

function handleRequestFrame(
  frame: RequestFrame,
  session: SocketSession,
  options: SocketHandlerOptions,
) {
  return Effect.gen(function* () {
    // D #705 CP4d — source the dispatch context from the live three-arm
    // `Connection` arm. The arm's `_tag` is the authentication gate
    // (`UnauthenticatedConnection` ⇒ not yet authed); its `originator`
    // drives the typed dispatcher.
    const arm = yield* options.services.connections.peek(session.connId);
    if (Option.isNone(arm)) return;
    const conn = arm.value;
    const isConnect = frame.method === Connect.name;
    if (!isConnect && conn._tag === "UnauthenticatedConnection") {
      yield* session.sendFrame(unauthorizedResponse(frame.id));
      return;
    }
    // Spec F (#617) §6 FRI cutover: dispatch through the per-connection
    // typed `ServerConnection.handle`. Each slot's residual R is `Env` (the
    // per-frame caps are discharged INSIDE the slot, #705 HALF-2); the
    // surrounding `ManagedRuntime<FullLive>` provides every handler-body Tag
    // at request time. The per-principal arm-narrow + the body's narrowed
    // `AgentContext`/`AppContext` are applied inside the slot body's
    // principal-kind gate (`defineMiddlewareMethod` / `defineUnauthMethod`,
    // #705 #720 §B1).
    const response = yield* conn.originator.handle(frame, {
      connection: conn,
    });
    yield* session.sendFrame(response);
    if (isConnect) yield* fireConnectionHooks(session, options);
  }).pipe(Effect.withSpan("socket.handleRequestFrame"));
}

function fireConnectionHooks(
  session: SocketSession,
  options: SocketHandlerOptions,
) {
  return Effect.gen(function* () {
    // D #705 CP4d — connection hooks fire only for an authenticated AGENT
    // (the hooks carry `agentId`); the app arm has no agent identity.
    const arm = yield* options.services.connections.peek(session.connId);
    if (Option.isNone(arm) || arm.value._tag !== "AgentConnection") return;
    const { agentId, ownerUserId } = arm.value.auth;
    const agentName = yield* readAgentName(agentId, options);
    for (const hook of options.connectionHooks) {
      yield* runConnectionHook(hook, {
        agentId,
        agentName,
        ownerUserId,
        connId: session.connId,
      });
    }
  }).pipe(Effect.withSpan("socket.fireConnectionHooks"));
}

function readAgentName(
  agentId: AgentContext["agentId"],
  options: SocketHandlerOptions,
) {
  return Effect.tryPromise(() =>
    options.services.db
      .selectFrom("agents")
      .select("name")
      .where("id", "=", agentId)
      .executeTakeFirst(),
  ).pipe(
    Effect.catchAll(() => Effect.succeed(undefined)),
    Effect.map((row) => row?.name ?? agentId),
  );
}

function runConnectionHook(
  hook: ConnectionHook,
  args: Parameters<ConnectionHook>[0],
) {
  return runUserHook(hook, args, "Connection hook", {
    agentId: args.agentId,
    connId: args.connId,
  });
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
    // D #705 CP4d — atomic delete + return of the live arm drives the
    // auth-gated cleanup. The agent arm carries the `AgentContext`; the app +
    // unauthenticated arms skip the agent-disconnect path.
    const removed = yield* options.services.connections.removeAndReturn(
      session.connId,
    );
    if (removed !== undefined && removed._tag === "AgentConnection") {
      const authCtx = removed.auth;
      // Emit `offline` via onAgentDisconnect(agentId, connId). connId
      // is threaded for the fast-reconnect race guard — the entry is
      // dropped only if connId is in liveConns (else silent no-op for
      // stale-session disconnects). Runs BEFORE leaseRegistry.abandon
      // so subsequent lease callbacks find the connId gone (audit at
      // debug, no emission).
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

function sendInvalidRequest(session: SocketSession) {
  return session.sendFrame(
    encodeErrorResponse(null, {
      code: JSON_RPC_RESERVED_CODES.InvalidRequest,
      message: "Invalid request frame",
    }),
  );
}

function unauthorizedResponse(id: JsonRpcId) {
  return encodeErrorResponse(id, {
    code: UnauthorizedError.code,
    message: "Not authenticated. Send network/connect first.",
  });
}
