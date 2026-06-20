/**
 * @file Two-engine `@effect/rpc` transport over one WebSocket.
 *
 * One physical `Socket.Socket` carries two role-inverted engines: a local
 * `RpcServer` that serves inbound requests, and a local `RpcClient` that
 * originates requests and consumes their responses. Both engines share the
 * socket; every frame is a bare JSON-RPC string with no envelope.
 *
 * Routing is by frame family, read off the already-serialized frame. The
 * `@effect/rpc` jsonRpc serialization tags a `Request` with a top-level
 * `method` string; the response frames (`Chunk`/`Exit`/`Defect`) carry
 * `result`/`error` and no `method`. So a `method` discriminates the family: a
 * frame with one is inbound to the local `RpcServer`, a frame without one is
 * inbound to the local `RpcClient`.
 *
 * Two protocol features are turned off so the only method-bearing frame on the
 * wire is a genuine `Request`, keeping the split exact:
 *
 * - The engines bind through the low-level `RpcServer.Protocol.make` /
 *   `RpcClient.Protocol.make` extension points rather than the stock socket
 *   protocol family. The stock protocols inject a `Ping` pinger whose `Pong`
 *   carries a `method` (and fails the socket on the pinger timeout); binding
 *   low-level injects no pinger, so `Ping`/`Pong` never reach this socket.
 *   Liveness is the caller's concern (the WS layer's ping/pong, or an
 *   app-level heartbeat).
 * - Acks are disabled (`supportsAck: false`). A client `Ack` also serializes
 *   to a method-bearing control frame, but it belongs to the response side;
 *   moltzap RPCs are unary, so the chunk-ack handshake is unnecessary and the
 *   ack frame never appears.
 *
 * ```mermaid
 * flowchart LR
 *   subgraph oneSocket [one WebSocket]
 *     W[socket.writer]
 *     R[socket.runRaw]
 *   end
 *   SE[server engine] -->|FromServerEncoded| SP[server Protocol]
 *   SP -->|encode via Parser| W
 *   R -->|bare frame| DEMUX{method?}
 *   DEMUX -->|yes: request| SP
 *   DEMUX -->|no: response| CP[client Protocol]
 *   CP -->|FromServerEncoded| CE[client engine]
 * ```
 */
import type {
  FromClientEncoded,
  FromServerEncoded,
} from "@effect/rpc/RpcMessage";
import { RpcSerialization } from "@effect/rpc";
import type * as Socket from "@effect/platform/Socket";
import { Effect, Mailbox, Option, Schema } from "effect";

/**
 * The raw-write surface the transport drives. Mirrors the effect returned by
 * `Socket.Socket["writer"]`: one call writes one chunk to the wire and
 * fails with a {@link Socket.SocketError} if the socket is gone.
 */
export type WireWrite = (
  chunk: string,
) => Effect.Effect<void, Socket.SocketError>;

/**
 * One engine's inbound sink the demux routes decoded frames into. Each sink
 * owns its engine's Parser and the `write` injector the Parser feeds.
 */
interface ChannelSink {
  readonly parser: RpcSerialization.Parser;
  readonly inject: (frame: unknown) => Effect.Effect<void>;
}

/**
 * The two role-inverted sinks on one socket. `server` is the local
 * `RpcServer`'s inbound sink (request-family frames); `client` is the local
 * `RpcClient`'s inbound sink (response-family frames). A socket may carry
 * either or both.
 */
export interface SocketSinks {
  readonly server?: ChannelSink;
  readonly client?: ChannelSink;
}

/**
 * The JSON-RPC reserved parse-error code (JSON-RPC 2.0 §5.1). The server
 * replies with this — rather than silently dropping — for a chunk it cannot
 * decode into a routable protocol frame, so a buggy or hostile client gets a
 * typed signal instead of a dead connection.
 */
const JSON_RPC_PARSE_ERROR_CODE = -32700;

/**
 * The bare reply the transport writes back when a chunk cannot be turned into
 * a protocol frame. The id is `null` (the frame was unparseable, so no request
 * id is recoverable). This is a fixed JSON-RPC shape, not an engine-encoded
 * frame: the inner parser already failed, so the engine never saw the request.
 */
const PARSE_ERROR_REPLY = JSON.stringify({
  jsonrpc: "2.0",
  id: null,
  error: {
    code: JSON_RPC_PARSE_ERROR_CODE,
    message: "invalid json",
  },
});

/** A no-op writer: the default when a caller wires no parse-error reply path. */
const dropWrite: WireWrite = () => Effect.void;

/**
 * Encode one engine frame through `encode` and write it to the wire, demoting a
 * socket write failure to a warning so one failed send does not fault the
 * engine. Shared by both channel protocols' `send`.
 */
const sendFrame = (
  encode: (frame: unknown) => Effect.Effect<string>,
  write: WireWrite,
  failureMessage: string,
  frame: unknown,
): Effect.Effect<void> =>
  encode(frame).pipe(
    Effect.flatMap(write),
    Effect.catchAll((err) =>
      Effect.logWarning(failureMessage).pipe(Effect.annotateLogs({ err })),
    ),
  );

/** Log + write the `-32700` parse-error frame through the resolved writer. */
const replyMalformed =
  (reply: WireWrite) =>
  (logMessage: string): Effect.Effect<void> =>
    Effect.logWarning(logMessage).pipe(
      Effect.zipRight(
        reply(PARSE_ERROR_REPLY).pipe(Effect.catchAll(() => Effect.void)),
      ),
    );

/**
 * The decoded `method` of a chunk, or `None` when the chunk is not a JSON
 * object. A string `method` marks a request-family frame; its absence marks a
 * response-family frame. A non-object chunk is malformed.
 */
const RoutingProbeSchema = Schema.Struct(
  { method: Schema.optional(Schema.String) },
  { key: Schema.String, value: Schema.Unknown },
);
const decodeRoutingProbe = Schema.decodeUnknownOption(RoutingProbeSchema);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const frameTag = (frame: unknown): unknown =>
  isRecord(frame) ? frame["_tag"] : undefined;

const isFromClientEncoded = (frame: unknown): frame is FromClientEncoded => {
  switch (frameTag(frame)) {
    case "Request":
    case "Ack":
    case "Interrupt":
    case "Ping":
    case "Eof":
      return true;
    default:
      return false;
  }
};

const isFromServerEncoded = (frame: unknown): frame is FromServerEncoded => {
  switch (frameTag(frame)) {
    case "Chunk":
    case "Exit":
    case "Defect":
    case "Pong":
    case "ClientProtocolError":
      return true;
    default:
      return false;
  }
};

/**
 * Route one raw socket chunk to the engine sink named by its frame family. A
 * chunk that does not decode into a routable protocol frame — non-JSON, a
 * non-object body, or an inner wire string the engine Parser rejects — is
 * answered with a JSON-RPC `-32700` parse-error reply (via `reply`) rather than
 * failing the socket: a single malformed frame must not tear down both engines
 * on the shared connection. When `reply` is omitted the chunk is dropped after
 * a warning. The engine's Parser may yield zero or more decoded frames per wire
 * string; every frame is injected in order.
 */
export function routeInbound(
  raw: string | Uint8Array,
  sinks: SocketSinks,
  reply?: WireWrite,
): Effect.Effect<void> {
  const onMalformed = replyMalformed(reply ?? dropWrite);
  return Effect.gen(function* () {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const parsed = yield* Effect.try((): unknown => JSON.parse(text)).pipe(
      Effect.option,
    );
    if (Option.isNone(parsed)) {
      return yield* onMalformed("mux: non-JSON socket chunk");
    }
    const probe = decodeRoutingProbe(parsed.value);
    if (Option.isNone(probe)) {
      return yield* onMalformed("mux: non-object socket chunk");
    }
    // A `method` marks the request family (Request/Ack/Interrupt/Eof) → the
    // local server; its absence marks the response family (Chunk/Exit/Defect)
    // → the local client.
    const sink = probe.value.method !== undefined ? sinks.server : sinks.client;
    if (sink === undefined) {
      return yield* onMalformed("mux: no sink for frame family");
    }
    const frames = yield* Effect.try(() => sink.parser.decode(text)).pipe(
      Effect.option,
    );
    if (Option.isNone(frames)) {
      return yield* onMalformed("mux: undecodable frame");
    }
    for (const frame of frames.value) {
      // A frame that parses into the right family but that the destination
      // engine cannot accept (e.g. a response-family frame with no usable
      // request id) makes the engine `write` throw — synchronously, while
      // building the inject Effect. `Effect.suspend` pulls that synchronous
      // throw into the Effect's defect channel so the catch below answers it as
      // a malformed frame, and one bad frame does not tear down both engines.
      yield* Effect.suspend(() => sink.inject(frame)).pipe(
        Effect.catchAllDefect(() => onMalformed("mux: engine rejected frame")),
      );
    }
  }).pipe(Effect.withSpan("mux.routeInbound"));
}

/**
 * The single physical client every engine on one socket shares. The server
 * `Protocol` keys per-client state by id; one socket carries one logical
 * client, so the server reports this id for the socket.
 */
const MUX_CLIENT_ID = 0;

/**
 * The server protocol-impl record `RpcServer.Protocol.make`'s callback
 * returns (its declared shape minus `run`, which the make wrapper adds).
 * Pinned here so {@link makeServerChannelProtocol}'s output matches the
 * extension point structurally, with no excess fields the make callback
 * would reject.
 */
interface ServerProtocolImpl {
  readonly disconnects: Mailbox.ReadonlyMailbox<number>;
  readonly send: (
    clientId: number,
    response: FromServerEncoded,
  ) => Effect.Effect<void>;
  readonly end: (clientId: number) => Effect.Effect<void>;
  readonly clientIds: Effect.Effect<ReadonlySet<number>>;
  readonly initialMessage: Effect.Effect<Option.Option<unknown>>;
  readonly supportsAck: boolean;
  readonly supportsTransferables: boolean;
  readonly supportsSpanPropagation: boolean;
}

/**
 * The client protocol-impl record `RpcClient.Protocol.make`'s callback
 * returns. Pinned for the same reason as {@link ServerProtocolImpl}.
 */
interface ClientProtocolImpl {
  readonly send: (request: FromClientEncoded) => Effect.Effect<void>;
  readonly supportsAck: boolean;
  readonly supportsTransferables: boolean;
}

/**
 * A built engine protocol: the exact impl record the corresponding
 * `Protocol.make` callback returns, plus the {@link ChannelSink} the demux
 * registers so inbound frames reach the engine. The two are split so the
 * `Protocol.make` callback returns only `impl` (no excess fields), while the
 * demux owns `sink`.
 */
export interface ChannelProtocol<Impl> {
  readonly impl: Impl;
  readonly sink: ChannelSink;
}

/**
 * Build the server-side `RpcServer.Protocol` impl over one socket. Pass the
 * resulting builder the engine's `write` injector (the argument
 * `RpcServer.Protocol.make` hands its callback); the builder returns the impl
 * record `Protocol.make` expects plus the {@link ChannelSink} the demux
 * registers.
 *
 * `send` encodes a `FromServerEncoded` through the engine's Parser and writes
 * the bare wire string. The sink's `inject` feeds decoded inbound
 * `FromClientEncoded` frames into the engine via `write`. Socket close is
 * surfaced through the shared `disconnects` Mailbox.
 */
export function makeServerChannelProtocol(options: {
  readonly write: WireWrite;
  readonly disconnects: Mailbox.Mailbox<number>;
}): (
  write: (clientId: number, data: FromClientEncoded) => Effect.Effect<void>,
) => Effect.Effect<ChannelProtocol<ServerProtocolImpl>> {
  const parser = RpcSerialization.jsonRpc().unsafeMake();
  const encode = makeEncoder(parser);
  return (write) =>
    Effect.succeed({
      impl: {
        disconnects: options.disconnects,
        send: (_clientId, response) =>
          sendFrame(encode, options.write, "mux: server send failed", response),
        end: () => Effect.void,
        clientIds: Effect.succeed(new Set([MUX_CLIENT_ID])),
        initialMessage: Effect.succeedNone,
        // Acks off: a client `Ack` serializes to a method-bearing control frame
        // (`{method: "@effect/rpc/Ack"}`) that the family split would misroute
        // to the request side. moltzap RPCs are unary, so the chunk-ack
        // handshake is unnecessary; disabling it keeps every method-bearing
        // frame a genuine request, so the split stays exact.
        supportsAck: false,
        supportsTransferables: false,
        supportsSpanPropagation: false,
      },
      sink: {
        parser,
        inject: (frame) =>
          isFromClientEncoded(frame)
            ? write(MUX_CLIENT_ID, frame)
            : Effect.dieMessage("mux: server sink received non-client frame"),
      },
    });
}

/**
 * Build the client-side `RpcClient.Protocol` impl over one socket. Mirrors
 * {@link makeServerChannelProtocol} for the client engine: `send` encodes a
 * `FromClientEncoded` through the engine's Parser and writes the bare wire
 * string; the sink's `inject` feeds decoded inbound `FromServerEncoded` frames
 * into the engine. The client engine has no `disconnects` Mailbox — socket
 * close fails the client call channel through the underlying socket.
 */
export function makeClientChannelProtocol(options: {
  readonly write: WireWrite;
}): (
  write: (data: FromServerEncoded) => Effect.Effect<void>,
) => Effect.Effect<ChannelProtocol<ClientProtocolImpl>> {
  const parser = RpcSerialization.jsonRpc().unsafeMake();
  const encode = makeEncoder(parser);
  return (write) =>
    Effect.succeed({
      impl: {
        send: (request) =>
          sendFrame(encode, options.write, "mux: client send failed", request),
        // Acks off — see {@link makeServerChannelProtocol}: the peer's `Ack`
        // is a method-bearing frame the family split would misroute, and unary
        // RPCs never need it.
        supportsAck: false,
        supportsTransferables: false,
      },
      sink: {
        parser,
        inject: (frame) =>
          isFromServerEncoded(frame)
            ? write(frame)
            : Effect.dieMessage("mux: client sink received non-server frame"),
      },
    });
}

/**
 * Encode an engine frame into the bare wire string via the engine's Parser.
 *
 * `unsafeMake()` is the engine `Parser`; `RpcSerialization.jsonRpc` is the
 * service value whose `unsafeMake()` builds it. The Parser's `encode` returns
 * `string | Uint8Array | undefined`; the jsonRpc Parser always yields a string
 * here (it never emits `undefined` for a real frame, and never a
 * `Uint8Array`), so a non-string result is a programmer error in the
 * serialization wiring, surfaced as a defect.
 */
function makeEncoder(
  parser: RpcSerialization.Parser,
): (frame: unknown) => Effect.Effect<string> {
  return (frame) => {
    const wire = parser.encode(frame);
    if (typeof wire !== "string") {
      return Effect.dieMessage(
        "mux: jsonRpc parser produced a non-string frame",
      );
    }
    return Effect.succeed(wire);
  };
}

/**
 * Drive the shared socket's read loop, routing every inbound chunk to the
 * engine sink named by its frame family. The owner forks this and surfaces
 * socket close to the server engine's `disconnects` Mailbox so per-client
 * teardown runs.
 */
export function runMuxReader(
  socket: Socket.Socket,
  sinks: SocketSinks,
  disconnects: Mailbox.Mailbox<number>,
  reply?: WireWrite,
): Effect.Effect<void, Socket.SocketError> {
  return socket
    .runRaw((data) => routeInbound(data, sinks, reply))
    .pipe(
      Effect.ensuring(disconnects.offer(MUX_CLIENT_ID).pipe(Effect.asVoid)),
    );
}

export type { ChannelSink };
