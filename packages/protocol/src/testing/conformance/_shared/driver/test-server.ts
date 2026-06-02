/**
 * TestServer — accepts real client WebSocket connections and lets property
 * code script arbitrary server-side traffic (valid notifications, malformed
 * frames, delayed / out-of-order sequences).
 *
 * Per D1 (WS-only) and Invariant I1, TestServer binds a real
 * `@effect/platform-node/NodeSocketServer.makeWebSocket` so the wire bytes
 * match `packages/server`'s real production path. TestServer is *not* an
 * in-process counterpart of TestClient; it exists to exercise real client
 * code (`packages/client`, `openclaw-channel`, `nanoclaw-channel`, arena).
 *
 * Satisfies AC3. Consumed by Tier A (A2), Tier B (server-emitted notification
 * replay), and Tier E E2 (schema-exhaustive fuzz).
 */
import { Context, Effect, Either, Ref, type Scope } from "effect";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Socket from "@effect/platform/Socket";
import * as SocketServer from "@effect/platform/SocketServer";
import type {
  NotificationFrame,
  ResponseFrame,
} from "../../../../transport/wire.js";
import {
  makeCaptureBuffer,
  mergeCaptures,
  recordFrame,
  recordMalformed,
  type CapturedFrame,
  type CaptureBuffer,
} from "../captures.js";
import {
  decodeFrame,
  encodeFrame,
  malformFrame,
  type AnyFrame,
  FrameSchemaError,
  type MalformedFrameKind,
} from "../frame-mutator.js";
import { TransportClosedError, TransportIoError } from "../errors.js";

const outboundTransportIoError = (cause: unknown): TransportIoError =>
  new TransportIoError({ direction: "outbound", cause });

const inboundTransportIoError = (cause: unknown): TransportIoError =>
  new TransportIoError({ direction: "inbound", cause });

const outboundTransportClosedError = (
  opts: { readonly code: number; readonly reason: string },
  cause: unknown,
): TransportClosedError =>
  new TransportClosedError({
    direction: "outbound",
    code: opts.code,
    reason: `${opts.reason}: ${String(cause)}`,
  });

// ── Mux envelope ─────────────────────────────────────────────────────────────
//
// The real clients (`packages/client`, the channels) multiplex the socket with
// a `{ ch, f }` envelope (`transport/mux.ts`) and the native engine mints
// NUMERIC ids the strict wire schema brands as strings, riding extra keys
// (`headers`/`traceId`/`spanId`/`sampled`). TestServer drives the same wire so
// its strict-frame `encodeFrame`/`decodeFrame` core stays envelope-agnostic:
// unwrap + strip extras + stringify a numeric id on receipt, wrap on send
// (responses on `c2s` where the request arrived, server-pushed
// notifications/callbacks on `s2c`).
const NATIVE_FRAME_EXTRAS = ["headers", "traceId", "spanId", "sampled"];

const parseObject = (raw: string): { readonly [k: string]: unknown } | null => {
  const v = Either.getOrNull(Either.try(() => JSON.parse(raw) as unknown));
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as { readonly [k: string]: unknown })
    : null;
};

function muxUnwrap(raw: string): string {
  const outer = parseObject(raw);
  // Only a WELL-FORMED envelope unwraps: `ch` MUST be a valid channel AND `f`
  // a string. A malformed envelope (missing/wrong `ch`) passes through raw so
  // `decodeFrame` rejects it — TestServer must still catch garbage framing, not
  // silently treat any `{ f }` object as the inner frame.
  const isEnvelope =
    outer !== null &&
    (outer["ch"] === "c2s" || outer["ch"] === "s2c") &&
    typeof outer["f"] === "string";
  const inner = isEnvelope ? (outer["f"] as string) : raw;
  const parsed = parseObject(inner);
  if (parsed === null) return inner;
  const frame: Record<string, unknown> = { ...parsed };
  for (const key of NATIVE_FRAME_EXTRAS) delete frame[key];
  if (typeof frame["id"] === "number") frame["id"] = String(frame["id"]);
  return JSON.stringify(frame);
}

// A monotonic id for server-pushed reverse RPCs (notifications/callbacks); the
// real client's reverse engine dispatches a request only when it carries an
// `id`, so a method-bearing frame lacking one gets a synthetic id.
let serverPushId = 0;

function muxWrap(raw: string): string {
  const parsed = parseObject(raw);
  if (parsed === null || typeof parsed["method"] !== "string") {
    // A response (no `method`) rides back on the c2s request channel.
    return JSON.stringify({ ch: "c2s", f: raw });
  }
  serverPushId += 1;
  const withId =
    "id" in parsed ? parsed : { ...parsed, id: String(serverPushId) };
  return JSON.stringify({ ch: "s2c", f: JSON.stringify(withId) });
}

export interface TestServerConfig {
  /** If 0, bind to an ephemeral port. */
  readonly port: number;
  /** Host string bound by the HTTP server; default `"127.0.0.1"`. */
  readonly host: string;
  readonly captureCapacity: number;
}

/**
 * A single live client connection accepted by TestServer. Identity is by
 * `connectionId` (monotonic), not by any agent-level claim — TestServer is
 * below the identity layer.
 */
export interface TestServerConnection {
  readonly connectionId: string;
  readonly remoteAddr: string;
  readonly inbound: CaptureBuffer;
  readonly emitNotification: (
    notification: NotificationFrame,
  ) => Effect.Effect<void, TransportIoError | FrameSchemaError>;
  readonly emitResponse: (
    response: ResponseFrame,
  ) => Effect.Effect<void, TransportIoError | FrameSchemaError>;
  readonly emitMalformed: (opts: {
    readonly baseNotification: NotificationFrame;
    readonly kind: MalformedFrameKind;
    readonly seed: number;
  }) => Effect.Effect<void, TransportIoError>;
  readonly close: (opts: {
    readonly code: number;
    readonly reason: string;
  }) => Effect.Effect<void, TransportClosedError>;
}

export interface TestServer {
  readonly wsUrl: string;
  readonly accept: Effect.Effect<TestServerConnection, TransportIoError>;
  readonly connections: Effect.Effect<ReadonlyArray<TestServerConnection>>;
  readonly allInbound: CaptureBuffer;
  readonly snapshot: Effect.Effect<ReadonlyArray<CapturedFrame>>;
}

export const TestServer = Context.GenericTag<TestServer>(
  "@moltzap/protocol/testing/TestServer",
);

let connectionCounter = 0;
const TEST_SERVER_SNAPSHOT_CONCURRENCY = 8;

type Writer = (
  chunk: string | Uint8Array | Socket.CloseEvent,
) => Effect.Effect<void, Socket.SocketError>;

interface TestServerRefs {
  readonly serverState: Ref.Ref<ReadonlyArray<TestServerConnection>>;
  readonly acceptQueue: Ref.Ref<ReadonlyArray<TestServerConnection>>;
}

/**
 * Build a `TestServerConnection` for a freshly-accepted socket. `writer`
 * is acquired by the caller; the per-connection receive loop is driven
 * separately via `sock.runRaw`.
 */
function makeConnection(
  writer: Writer,
  captureCapacity: number,
  remoteAddr: string,
): Effect.Effect<TestServerConnection> {
  return Effect.gen(function* () {
    connectionCounter += 1;
    const connectionId = `conn-${connectionCounter}`;
    const inbound = yield* makeCaptureBuffer({ capacity: captureCapacity });

    const emit = (
      frame: AnyFrame,
    ): Effect.Effect<void, TransportIoError | FrameSchemaError> =>
      Effect.gen(function* () {
        const raw = encodeFrame(frame);
        // Validate on the way out as well — Invariant I3.
        yield* decodeFrame(raw, "outbound");
        yield* writer(muxWrap(raw)).pipe(
          Effect.mapError(outboundTransportIoError),
        );
        yield* recordFrame(inbound, "outbound", raw, frame);
      });

    return {
      connectionId,
      remoteAddr,
      inbound,
      emitNotification: (notification) => emit(notification as AnyFrame),
      emitResponse: (response) => emit(response as AnyFrame),
      emitMalformed: (opts) =>
        Effect.gen(function* () {
          const base: AnyFrame = opts.baseNotification as AnyFrame;
          const raw = malformFrame(base, opts.kind, opts.seed);
          // Wrap on the `s2c` channel so the malformed bytes reach the real
          // client's reverse reader — the malformed-frame property asserts the
          // client survives a poisoned NOTIFICATION, which rides s2c.
          yield* writer(JSON.stringify({ ch: "s2c", f: raw })).pipe(
            Effect.mapError(outboundTransportIoError),
          );
          yield* recordMalformed(inbound, raw, opts.kind);
        }),
      close: (opts) =>
        writer(new Socket.CloseEvent(opts.code, opts.reason)).pipe(
          Effect.mapError((err) => outboundTransportClosedError(opts, err)),
        ),
    } satisfies TestServerConnection;
  });
}

function rawSocketDataToString(data: string | Uint8Array): string {
  return typeof data === "string"
    ? data
    : new TextDecoder("utf-8").decode(data);
}

function recordConnectionInbound(
  conn: TestServerConnection,
  data: string | Uint8Array,
): Effect.Effect<void> {
  const raw = muxUnwrap(rawSocketDataToString(data));
  return decodeFrame(raw, "inbound").pipe(
    Effect.matchEffect({
      onFailure: () => recordMalformed(conn.inbound, raw, "bit-flip"),
      onSuccess: (frame) => recordFrame(conn.inbound, "inbound", raw, frame),
    }),
  );
}

/**
 * Bind an `@effect/platform` WebSocket server. The surrounding `Scope` owns
 * the listener; releasing it closes every open connection, drains captures,
 * and awaits port release.
 */
export function makeTestServer(
  config: TestServerConfig,
): Effect.Effect<TestServer, TransportIoError, Scope.Scope> {
  return Effect.gen(function* () {
    const refs = yield* makeTestServerRefs();
    const server = yield* bindWebSocketServer(config);
    yield* startAcceptLoop(server, refs, config);
    const wsUrl = yield* wsUrlFromAddress(server.address);
    const allInbound = yield* mergeCaptures([]);
    return {
      wsUrl,
      accept: acceptConnection(refs),
      connections: Ref.get(refs.serverState),
      allInbound,
      snapshot: snapshotConnections(refs),
    } satisfies TestServer;
  }).pipe(Effect.withSpan("makeTestServer"));
}

function makeTestServerRefs(): Effect.Effect<TestServerRefs> {
  return Effect.gen(function* () {
    return {
      serverState: yield* Ref.make<ReadonlyArray<TestServerConnection>>([]),
      acceptQueue: yield* Ref.make<ReadonlyArray<TestServerConnection>>([]),
    };
  });
}

function bindWebSocketServer(
  config: TestServerConfig,
): Effect.Effect<
  SocketServer.SocketServer["Type"],
  TransportIoError,
  Scope.Scope
> {
  return NodeSocketServer.makeWebSocket({
    port: config.port,
    host: config.host,
  }).pipe(Effect.mapError(inboundTransportIoError));
}

function startAcceptLoop(
  server: SocketServer.SocketServer["Type"],
  refs: TestServerRefs,
  config: TestServerConfig,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.forkScoped(
    server
      .run((socket) => handleAcceptedSocket(socket, refs, config))
      .pipe(Effect.ignore),
  ).pipe(Effect.asVoid);
}

function handleAcceptedSocket(
  socket: Socket.Socket,
  refs: TestServerRefs,
  config: TestServerConfig,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const writer = yield* socket.writer;
    const conn = yield* makeConnection(
      writer as Writer,
      config.captureCapacity,
      "",
    );
    yield* appendConnection(refs.serverState, conn);
    yield* appendConnection(refs.acceptQueue, conn);
    yield* socket
      .runRaw((data) => recordConnectionInbound(conn, data))
      .pipe(Effect.ignore);
  });
}

function appendConnection(
  ref: Ref.Ref<ReadonlyArray<TestServerConnection>>,
  conn: TestServerConnection,
): Effect.Effect<void> {
  return Ref.update(ref, (connections) => [...connections, conn]);
}

function wsUrlFromAddress(
  address: SocketServer.Address,
): Effect.Effect<string, TransportIoError> {
  return address._tag === "TcpAddress"
    ? Effect.succeed(`ws://${address.hostname}:${address.port}`)
    : Effect.fail(
        new TransportIoError({
          direction: "inbound",
          cause: new Error(`expected TcpAddress, got ${address._tag}`),
        }),
      );
}

function acceptConnection(
  refs: TestServerRefs,
): Effect.Effect<TestServerConnection, TransportIoError> {
  return Effect.gen(function* () {
    while (true) {
      const accepted = yield* takeAcceptedConnection(refs.acceptQueue);
      if (accepted !== null) return accepted;
      yield* Effect.sleep("10 millis");
    }
  });
}

function takeAcceptedConnection(
  acceptQueue: Ref.Ref<ReadonlyArray<TestServerConnection>>,
): Effect.Effect<TestServerConnection | null> {
  return Ref.modify(acceptQueue, (queue) => {
    const [next, ...rest] = queue;
    return next === undefined ? [null, queue] : [next, rest];
  });
}

function snapshotConnections(
  refs: TestServerRefs,
): Effect.Effect<ReadonlyArray<CapturedFrame>> {
  return Effect.gen(function* () {
    const conns = yield* Ref.get(refs.serverState);
    const snaps = yield* Effect.forEach(
      conns,
      (conn) => conn.inbound.snapshot,
      {
        concurrency: TEST_SERVER_SNAPSHOT_CONCURRENCY,
      },
    );
    return snaps.flat();
  });
}
