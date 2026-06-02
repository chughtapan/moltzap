/**
 * @file Channel-multiplexed `@effect/rpc` transport over one WebSocket.
 *
 * One physical `Socket.Socket` carries every logical RPC endpoint. A
 * single socket is split by a channel-tagged envelope `{ch, f}`: `ch`
 * names the logical endpoint, `f` carries that endpoint's serialized
 * wire string. Each endpoint owns its own `RpcSerialization` Parser, so
 * the mux — not the engine — owns framing: a frame is encoded to a wire
 * string by the endpoint's Parser, wrapped in the envelope, and routed
 * back to the same endpoint's Parser on receipt.
 *
 * Routing the raw frame object instead of the encoded string bypasses
 * the serialization layer, so the envelope always carries the encoded
 * string and decodes per-endpoint on receipt.
 *
 * The server and client engines bind to this mux through the low-level
 * `RpcServer.Protocol.make` / `RpcClient.Protocol.make` extension points
 * rather than the stock socket protocol family: the stock protocols
 * inject `constPing` frames that are unroutable through the `{ch, f}`
 * envelope and fail the socket on the pinger timeout. Liveness is the
 * caller's concern (the WS layer's ping/pong, or a mux heartbeat).
 *
 * ```mermaid
 * flowchart LR
 *   subgraph oneSocket [one WebSocket]
 *     W[socket.writer]
 *     R[socket.runRaw]
 *   end
 *   SE[server engine] -->|FromServerEncoded| SP[server Protocol]
 *   SP -->|encode via endpoint Parser| ENV1["{ch, f}"]
 *   ENV1 --> W
 *   R -->|"{ch, f}"| DEMUX[route by ch]
 *   DEMUX -->|decode via endpoint Parser| CP[client Protocol]
 *   CP -->|FromServerEncoded| CE[client engine]
 * ```
 */
import type {
  FromClientEncoded,
  FromServerEncoded,
} from "@effect/rpc/RpcMessage";
import { RpcSerialization } from "@effect/rpc";
import type * as Socket from "@effect/platform/Socket";
import { Effect, Either, Mailbox, Option, Schema } from "effect";

/**
 * A logical endpoint's slot on the shared socket. `c2s` carries the
 * client→server RPC group; `s2c` carries the server-originated callback
 * group (the role-inverted endpoint). Adding a logical endpoint adds a
 * channel here so the demux stays exhaustive.
 */
export type MuxChannel = "c2s" | "s2c";

/**
 * The channel-tagged envelope every multiplexed frame rides in. `ch`
 * routes the frame to one endpoint's Parser; `f` is that endpoint's
 * encoded wire string (a `JSON.stringify`'d RPC frame). The mux owns
 * this framing, so the per-endpoint Parser runs with
 * `includesFraming=false`.
 */
const MuxEnvelopeSchema = Schema.Struct({
  ch: Schema.Literal("c2s", "s2c"),
  f: Schema.String,
});

/**
 * The envelope's decoded form. `ch` is narrowed to {@link MuxChannel};
 * `f` is the per-endpoint encoded wire string awaiting that endpoint's
 * Parser.
 */
export type MuxEnvelope = typeof MuxEnvelopeSchema.Type;

const decodeEnvelope = Schema.decodeUnknownEither(MuxEnvelopeSchema);

/**
 * The raw-write surface the mux drives. Mirrors the effect returned by
 * `Socket.Socket["writer"]`: one call writes one chunk to the wire and
 * fails with a {@link Socket.SocketError} if the socket is gone.
 */
export type WireWrite = (
  chunk: string,
) => Effect.Effect<void, Socket.SocketError>;

/**
 * Encode an endpoint frame into a wire string via that endpoint's
 * Parser, then wrap it in the `{ch, f}` envelope ready for the socket.
 *
 * `unsafeMake()` is the per-endpoint `Parser`; `RpcSerialization.json`
 * is the service value whose `unsafeMake()` builds it. The Parser's
 * `encode` returns `string | Uint8Array | undefined`; the JSON Parser
 * always yields a string here (it never emits `undefined` for a real
 * frame, and never a `Uint8Array`), so a non-string result is a
 * programmer error in the serialization wiring, surfaced as a defect.
 */
function makeEnvelopeEncoder(
  channel: MuxChannel,
  parser: RpcSerialization.Parser,
): (frame: unknown) => Effect.Effect<string> {
  return (frame) => {
    const wire = parser.encode(frame);
    if (typeof wire !== "string") {
      return Effect.dieMessage(
        `native-mux: JSON parser produced a non-string frame on channel ${channel}`,
      );
    }
    return Effect.succeed(
      JSON.stringify({ ch: channel, f: wire } satisfies MuxEnvelope),
    );
  };
}

/**
 * The per-channel inbound sinks the demux routes decoded wire strings
 * into. Each sink owns its endpoint's Parser and the engine-side
 * `write` injector the Parser feeds.
 */
interface ChannelSink {
  readonly parser: RpcSerialization.Parser;
  readonly inject: (frame: unknown) => Effect.Effect<void>;
}

/**
 * The JSON-RPC reserved parse-error code (JSON-RPC 2.0 §5.1). The
 * server replies with this — rather than silently dropping — for a
 * chunk it cannot decode into a routable protocol frame, so a buggy or
 * hostile client gets a typed signal instead of a dead connection.
 */
const JSON_RPC_PARSE_ERROR_CODE = -32700;

/**
 * The enveloped reply the mux writes back when a chunk cannot be turned
 * into a protocol frame. The id is `null` (the frame was unparseable, so
 * no request id is recoverable) and the channel matches the inbound
 * `c2s` request channel so the client's reader routes it like any
 * response. This is a fixed JSON-RPC shape, not an engine-encoded frame:
 * the inner parser already failed, so the engine never saw the request.
 */
const parseErrorReply = (channel: MuxChannel): string =>
  JSON.stringify({
    ch: channel,
    f: JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: JSON_RPC_PARSE_ERROR_CODE,
        message: "invalid json",
      },
    }),
  } satisfies MuxEnvelope);

/**
 * Route one raw socket chunk to the channel sink named by its envelope.
 * A chunk that does not decode into a routable protocol frame — non-JSON,
 * a malformed `{ch, f}` envelope, an unknown channel, or an inner wire
 * string the endpoint Parser rejects — is answered with a JSON-RPC
 * `-32700` parse-error reply (via `reply`) rather than failing the
 * socket: a single malformed frame must not tear down every endpoint on
 * the shared connection. When `reply` is omitted the chunk is dropped
 * after a warning. Each endpoint's Parser may yield zero or more decoded
 * frames per wire string; every frame is injected in order.
 */
type RoutedChunk = readonly [ChannelSink, MuxChannel, string];

/** A no-op writer: the default when a caller wires no parse-error reply path. */
const dropWrite: WireWrite = () => Effect.void;

/** Log + write the `-32700` parse-error envelope through the resolved writer. */
const replyMalformed =
  (reply: WireWrite) =>
  (logMessage: string, channel: MuxChannel): Effect.Effect<void> =>
    Effect.logWarning(logMessage).pipe(
      Effect.zipRight(
        reply(parseErrorReply(channel)).pipe(
          Effect.catchAll(() => Effect.void),
        ),
      ),
    );

/**
 * Decode the `{ch, f}` envelope and resolve its target sink. Returns
 * `None` (after a malformed reply) for a chunk that is not JSON, not a
 * well-formed envelope, or names an unregistered channel.
 */
function resolveRoute(
  raw: string | Uint8Array,
  sinks: Partial<Record<MuxChannel, ChannelSink>>,
  onMalformed: (logMessage: string, channel: MuxChannel) => Effect.Effect<void>,
): Effect.Effect<Option.Option<RoutedChunk>> {
  return Effect.gen(function* () {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const parsed = yield* Effect.try(() => JSON.parse(text) as unknown).pipe(
      Effect.option,
    );
    if (Option.isNone(parsed)) {
      yield* onMalformed("native-mux: non-JSON socket chunk", "c2s");
      return Option.none();
    }
    return yield* decodeEnvelope(parsed.value).pipe(
      Either.match({
        onLeft: () =>
          onMalformed("native-mux: malformed envelope", "c2s").pipe(
            Effect.as(Option.none<RoutedChunk>()),
          ),
        onRight: (env) => {
          const matched = sinks[env.ch];
          return matched === undefined
            ? onMalformed("native-mux: chunk for unknown channel", env.ch).pipe(
                Effect.as(Option.none<RoutedChunk>()),
              )
            : Effect.succeedSome([matched, env.ch, env.f] as const);
        },
      }),
    );
  });
}

export function routeInbound(
  raw: string | Uint8Array,
  sinks: Partial<Record<MuxChannel, ChannelSink>>,
  reply?: WireWrite,
): Effect.Effect<void> {
  const onMalformed = replyMalformed(reply ?? dropWrite);
  return Effect.gen(function* () {
    const route = yield* resolveRoute(raw, sinks, onMalformed);
    if (Option.isNone(route)) return;
    const [channelSink, channel, wire] = route.value;
    const frames = yield* Effect.try(() =>
      channelSink.parser.decode(wire),
    ).pipe(Effect.option);
    if (Option.isNone(frames)) {
      yield* onMalformed("native-mux: undecodable inner frame", channel);
      return;
    }
    for (const frame of frames.value) {
      yield* channelSink.inject(frame);
    }
  }).pipe(Effect.withSpan("native-mux.routeInbound"));
}

/**
 * The single physical client every endpoint on one socket shares. The
 * server `Protocol` keys per-client state by id; a mux carries one
 * socket, so every channel reports the same id.
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
 * A built channel protocol: the exact impl record the corresponding
 * `Protocol.make` callback returns, plus the {@link ChannelSink} the
 * demux registers so inbound frames on this channel reach the engine.
 * The two are split so the `Protocol.make` callback returns only `impl`
 * (no excess fields), while the demux owns `sink`.
 */
export interface ChannelProtocol<Impl> {
  readonly impl: Impl;
  readonly sink: ChannelSink;
}

/**
 * Build the server-side `RpcServer.Protocol` impl over one socket
 * channel. Pass the resulting builder the engine's `write` injector
 * (the argument `RpcServer.Protocol.make` hands its callback); the
 * builder returns the impl record `Protocol.make` expects plus the
 * {@link ChannelSink} the demux registers.
 *
 * `send` encodes a `FromServerEncoded` through the channel's Parser and
 * writes the enveloped wire string. The sink's `inject` feeds decoded
 * inbound `FromClientEncoded` frames into the engine via `write`.
 * Socket close is surfaced through the shared `disconnects` Mailbox.
 */
export function makeServerChannelProtocol(options: {
  readonly channel: MuxChannel;
  readonly write: WireWrite;
  readonly disconnects: Mailbox.Mailbox<number>;
}): (
  write: (clientId: number, data: FromClientEncoded) => Effect.Effect<void>,
) => Effect.Effect<ChannelProtocol<ServerProtocolImpl>> {
  const parser = RpcSerialization.jsonRpc().unsafeMake();
  const encode = makeEnvelopeEncoder(options.channel, parser);
  return (write) =>
    Effect.succeed({
      impl: {
        disconnects: options.disconnects,
        send: (_clientId, response) =>
          encode(response).pipe(
            Effect.flatMap(options.write),
            Effect.catchAll((err) =>
              Effect.logWarning("native-mux: server send failed").pipe(
                Effect.annotateLogs({ err, channel: options.channel }),
              ),
            ),
          ),
        end: () => Effect.void,
        clientIds: Effect.succeed(new Set([MUX_CLIENT_ID])),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: false,
      },
      sink: {
        parser,
        inject: (frame) => write(MUX_CLIENT_ID, frame as FromClientEncoded),
      },
    });
}

/**
 * Build the client-side `RpcClient.Protocol` impl over one socket
 * channel. Mirrors {@link makeServerChannelProtocol} for the client
 * engine: `send` encodes a `FromClientEncoded` through the channel's
 * Parser and writes the enveloped wire string; the sink's `inject`
 * feeds decoded inbound `FromServerEncoded` frames into the engine. The
 * client engine has no `disconnects` Mailbox — socket close fails the
 * client call channel through the underlying socket.
 */
export function makeClientChannelProtocol(options: {
  readonly channel: MuxChannel;
  readonly write: WireWrite;
}): (
  write: (data: FromServerEncoded) => Effect.Effect<void>,
) => Effect.Effect<ChannelProtocol<ClientProtocolImpl>> {
  const parser = RpcSerialization.jsonRpc().unsafeMake();
  const encode = makeEnvelopeEncoder(options.channel, parser);
  return (write) =>
    Effect.succeed({
      impl: {
        send: (request) =>
          encode(request).pipe(
            Effect.flatMap(options.write),
            Effect.catchAll((err) =>
              Effect.logWarning("native-mux: client send failed").pipe(
                Effect.annotateLogs({ err, channel: options.channel }),
              ),
            ),
          ),
        supportsAck: true,
        supportsTransferables: false,
      },
      sink: {
        parser,
        inject: (frame) => write(frame as FromServerEncoded),
      },
    });
}

/**
 * Drive the shared socket's read loop, routing every inbound chunk to
 * the channel sink named by its envelope. The owner forks this and
 * surfaces socket close to the server engine's `disconnects` Mailbox so
 * per-client teardown runs.
 */
export function runMuxReader(
  socket: Socket.Socket,
  sinks: Partial<Record<MuxChannel, ChannelSink>>,
  disconnects: Mailbox.Mailbox<number>,
  reply?: WireWrite,
): Effect.Effect<void, Socket.SocketError> {
  return socket
    .runRaw((data) => routeInbound(data, sinks, reply))
    .pipe(
      Effect.ensuring(disconnects.offer(MUX_CLIENT_ID).pipe(Effect.asVoid)),
    );
}

export { MUX_CLIENT_ID };
export type { ChannelSink };
