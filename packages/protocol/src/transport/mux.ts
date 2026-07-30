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
import * as Socket from "@effect/platform/Socket";
import { Effect, type Mailbox, Option, Schema } from "effect";

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
 * Encode one engine frame through `encode` and write it to the wire. A failed
 * write remains a failure; treating it as success would let the RPC engine wait
 * for a frame that never left this process.
 * @param encode Value supplied to the operation.
 * @param write Value supplied to the operation.
 * @param frame Value supplied to the operation.
 * @returns The send frame result.
 */
const sendFrame = (
  encode: (frame: unknown) => Effect.Effect<string>,
  write: WireWrite,
  frame: unknown,
): Effect.Effect<void, Socket.SocketError> =>
  encode(frame).pipe(Effect.flatMap(write));

const socketReadFailure = (
  failure: string,
  cause: unknown,
): Socket.SocketError =>
  new Socket.SocketGenericError({
    reason: "Read",
    cause: { failure, cause },
  });

const failRead = (
  failure: string,
  cause: unknown = failure,
): Effect.Effect<never, Socket.SocketError> =>
  Effect.fail(socketReadFailure(failure, cause));

/**
 * The decoded `method` of a chunk, or `None` when the chunk is not a JSON
 * object. A string `method` marks a request-family frame; its absence marks a
 * response-family frame. A non-object chunk is malformed.
 */
const routingProbeSchema = Schema.Struct(
  { method: Schema.optional(Schema.String) },
  { key: Schema.String, value: Schema.Unknown },
);
const decodeRoutingProbe = Schema.decodeUnknownOption(routingProbeSchema);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const frameTag = (frame: unknown): unknown =>
  isRecord(frame) ? frame._tag : undefined;

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
 * non-object body, an inner wire string the engine Parser rejects, or a frame
 * the selected engine cannot accept — fails the socket read path. No
 * transport-authored error frame is sent: replying to malformed input lets two
 * peers bounce parse errors indefinitely. The engine's Parser may yield one or
 * more decoded frames per wire string; every frame is injected in order.
 * @param raw Value supplied to the operation.
 * @param sinks Value supplied to the operation.
 * @returns The route inbound result.
 */
export function routeInbound(
  raw: string | Uint8Array,
  sinks: SocketSinks,
): Effect.Effect<void, Socket.SocketError> {
  return Effect.gen(function* () {
    const text = yield* Effect.try({
      try: () =>
        typeof raw === "string"
          ? raw
          : new TextDecoder("utf-8", { fatal: true }).decode(raw),
      catch: (cause) => socketReadFailure("mux: invalid UTF-8 chunk", cause),
    });
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: (cause) => socketReadFailure("mux: non-JSON socket chunk", cause),
    });
    const probe = decodeRoutingProbe(parsed);
    if (Option.isNone(probe)) {
      return yield* failRead("mux: non-object socket chunk");
    }
    // A `method` marks the request family (Request/Ack/Interrupt/Eof) → the
    // local server; its absence marks the response family (Chunk/Exit/Defect)
    // → the local client.
    const sink = probe.value.method !== undefined ? sinks.server : sinks.client;
    if (sink === undefined) {
      return yield* failRead("mux: no sink for frame family");
    }
    const frames = yield* Effect.try({
      try: () => sink.parser.decode(text),
      catch: (cause) => socketReadFailure("mux: undecodable frame", cause),
    });
    if (frames.length === 0) {
      return yield* failRead("mux: parser produced no frame");
    }
    for (const frame of frames) {
      yield* Effect.suspend(() => sink.inject(frame)).pipe(
        Effect.catchAllDefect((cause) =>
          failRead("mux: engine rejected decoded frame", cause),
        ),
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
 * @param options Options that control the operation.
 * @param options.write Value supplied to the operation.
 * @param options.disconnects Value supplied to the operation.
 * @returns The created server channel protocol.
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
        send: (clientId, response) =>
          clientId === MUX_CLIENT_ID
            ? sendFrame(encode, options.write, response).pipe(Effect.orDie)
            : Effect.dieMessage(`mux: unknown client id ${String(clientId)}`),
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
 * @param options Options that control the operation.
 * @param options.write Value supplied to the operation.
 * @returns The created client channel protocol.
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
          sendFrame(encode, options.write, request).pipe(Effect.orDie),
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
 * @param parser Value supplied to the operation.
 * @returns The created encoder.
 */
function makeEncoder(
  parser: RpcSerialization.Parser,
): (frame: unknown) => Effect.Effect<string> {
  return (frame) =>
    Effect.sync(() => parser.encode(frame)).pipe(
      Effect.flatMap((wire) =>
        typeof wire === "string"
          ? Effect.succeed(wire)
          : Effect.dieMessage(
              "mux: jsonRpc parser produced a non-string frame",
            ),
      ),
    );
}

/**
 * Drive the shared socket's read loop, routing every inbound chunk to the
 * engine sink named by its frame family. The owner forks this and surfaces
 * socket close to the server engine's `disconnects` Mailbox so per-client
 * teardown runs.
 * @param socket Value supplied to the operation.
 * @param sinks Value supplied to the operation.
 * @param disconnects Value supplied to the operation.
 * @returns The run mux reader result.
 */
export function runMuxReader(
  socket: Socket.Socket,
  sinks: SocketSinks,
  disconnects: Mailbox.Mailbox<number>,
): Effect.Effect<void, Socket.SocketError> {
  return socket
    .runRaw((data) => routeInbound(data, sinks))
    .pipe(
      Effect.ensuring(disconnects.offer(MUX_CLIENT_ID).pipe(Effect.asVoid)),
    );
}

/** Re-exports the public API from `current module`. */
export type { ChannelSink };
