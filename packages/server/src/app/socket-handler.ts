import * as Socket from "@effect/platform/Socket";
import { Cause, Deferred, Effect, Exit, Match, type Scope } from "effect";
import type {
  JsonRpcId,
  RequestFrame,
  ResponseFrame,
  ServerHandlers,
} from "@moltzap/protocol";
import {
  Connect,
  JSON_RPC_RESERVED_CODES,
  UnauthorizedError,
  decodeClientInbound,
  encodeErrorResponse,
  makeServerConnection,
} from "@moltzap/protocol";

import type {
  AuthenticatedContext,
  DispatchContext,
} from "../transport/context.js";
import { connectionId as brandConnectionId } from "../network/agent-endpoint-resolver.js";
import type { AppTags } from "../transport/layer-tags.js";
import { serverCapabilityProviders } from "./capability-providers.js";
import type { ConnIdTag, ResolvedServices } from "./layers.js";
import { logInfo, logWarning } from "./logging.js";

const ERROR_INVALID_JSON = "Invalid JSON";

const UTF8_DECODER = new TextDecoder("utf-8");
const MALFORMED_LOG_EVERY = 50;

type SocketWrite = (raw: string) => Effect.Effect<void, Socket.SocketError>;
type SendFrame = (obj: unknown) => Effect.Effect<void>;

interface SocketHandlerOptions {
  readonly services: Pick<
    ResolvedServices,
    | "connections"
    | "agentEndpointResolver"
    | "presenceService"
    | "leaseRegistry"
  >;
  readonly handlers: ServerHandlers<DispatchContext>;
}

interface SocketSession {
  readonly connId: string;
  readonly write: SocketWrite;
  readonly sendFrame: SendFrame;
  readonly closeRequested: Deferred.Deferred<void>;
  readonly malformedFrames: { count: number };
}

export function makeSocketHandler(options: SocketHandlerOptions) {
  return (
    socket: Socket.Socket,
  ): Effect.Effect<void, Socket.SocketError, Exclude<AppTags, ConnIdTag>> =>
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
    const serverConn = yield* makeServerConnection({
      id: session.connId,
      handlers: options.handlers,
      capabilities: serverCapabilityProviders,
      write: session.write,
      idPrefix: `srv-${session.connId}`,
    });
    options.services.connections.add({
      id: session.connId,
      write: session.write,
      shutdown: Deferred.succeed(session.closeRequested, undefined).pipe(
        Effect.asVoid,
      ),
      auth: null,
      lastPong: Date.now(),
      conversationIds: new Set(),
      mutedConversations: new Set(),
      originator: serverConn,
    });
    yield* logInfo("WebSocket connected", { connId: session.connId });
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
    const connId = crypto.randomUUID();
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

function makeSendFrame(connId: string, write: SocketWrite): SendFrame {
  return (obj) =>
    write(JSON.stringify(obj)).pipe(
      Effect.catchAll((err) =>
        logWarning("socket write failed", { err, connId }),
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

function handleFrame(
  raw: string,
  session: SocketSession,
  options: SocketHandlerOptions,
) {
  return Effect.gen(function* () {
    if (!options.services.connections.get(session.connId)) return;
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
      yield* logWarning("Failed to parse WebSocket frame", {
        err,
        connId: session.connId,
        count,
      });
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
    const conn = options.services.connections.get(session.connId);
    if (conn === undefined) return;
    const matched = yield* conn.originator.resolve(frame);
    if (!matched) {
      const responseId = frame.id;
      yield* logWarning(
        "no pending appCallback request matched inbound response",
        { connId: session.connId, id: responseId },
      );
    }
  }).pipe(Effect.withSpan("socket.handleResponseFrame"));
}

function handleRequestFrame(
  frame: RequestFrame,
  session: SocketSession,
  options: SocketHandlerOptions,
) {
  return Effect.gen(function* () {
    const conn = options.services.connections.get(session.connId);
    if (conn === undefined) return;
    const isConnect = frame.method === Connect.name;
    if (!isConnect && conn.auth === null) {
      yield* session.sendFrame(unauthorizedResponse(frame.id));
      return;
    }
    const auth = conn.auth ?? ({} as AuthenticatedContext);
    // Spec F (#617) §6 FRI cutover: dispatch through the per-connection
    // typed `ServerConnection.handle`. The dispatcher casts R to `never`
    // via `asNeverR`; the surrounding `ManagedRuntime<FullLive>`
    // provides every handler-body Tag at request time.
    const response = yield* conn.originator.handle(frame, {
      auth,
      connId: session.connId,
    });
    yield* session.sendFrame(response);
  }).pipe(Effect.withSpan("socket.handleRequestFrame"));
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
    const conn = options.services.connections.get(session.connId);
    const authCtx = conn?.auth ?? null;
    if (authCtx !== null) {
      options.services.presenceService.setOffline(authCtx.agentId);
      yield* options.services.agentEndpointResolver.remove(
        authCtx.agentId,
        brandConnectionId(session.connId),
      );
    }
    yield* options.services.leaseRegistry.abandon(session.connId);
    options.services.presenceService.removeConnection(session.connId);
    options.services.connections.remove(session.connId);
    if (Exit.isFailure(exit)) {
      yield* logWarning("WebSocket error", {
        connId: session.connId,
        cause: Cause.pretty(exit.cause),
      });
    }
    yield* logInfo("WebSocket disconnected", { connId: session.connId });
  }).pipe(Effect.withSpan("socket.closeSession"));
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
