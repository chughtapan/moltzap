/**
 * TestServer — accepts real client WebSocket connections and lets property
 * code script arbitrary server-side traffic (valid events, malformed
 * frames, delayed / out-of-order sequences).
 *
 * Per D1 (WS-only) and Invariant I1, TestServer binds a real
 * `@effect/platform-node/NodeSocketServer.makeWebSocket` so the wire bytes
 * match `packages/server`'s real production path. TestServer is *not* an
 * in-process counterpart of TestClient; it exists to exercise real client
 * code (`packages/client`, `openclaw-channel`, `nanoclaw-channel`, arena).
 *
 * Satisfies AC3. Consumed by Tier A (A2), Tier B (server-emitted event
 * replay), and Tier E E2 (schema-exhaustive fuzz).
 */
import { Context, Effect, Ref, type Scope } from "effect";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import * as Socket from "@effect/platform/Socket";
import type { EventFrame, ResponseFrame } from "../schema/frames.js";
import {
  makeCaptureBuffer,
  mergeCaptures,
  recordFrame,
  recordMalformed,
  type CapturedFrame,
  type CaptureBuffer,
} from "./captures.js";
import {
  decodeFrame,
  encodeFrame,
  malformFrame,
  type AnyFrame,
  type MalformedFrameKind,
} from "./codec.js";
import {
  FrameSchemaError,
  TransportClosedError,
  TransportIoError,
} from "./errors.js";

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
  readonly emitEvent: (
    event: EventFrame,
  ) => Effect.Effect<void, TransportIoError | FrameSchemaError>;
  readonly emitResponse: (
    response: ResponseFrame,
  ) => Effect.Effect<void, TransportIoError | FrameSchemaError>;
  readonly emitMalformed: (opts: {
    readonly baseEvent: EventFrame;
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

type Writer = (
  chunk: string | Uint8Array | Socket.CloseEvent,
) => Effect.Effect<void, Socket.SocketError>;

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
        const check = yield* Effect.either(decodeFrame(raw, "outbound"));
        if (check._tag === "Left") {
          return yield* Effect.fail(check.left);
        }
        yield* writer(raw).pipe(
          Effect.mapError(
            (err) =>
              new TransportIoError({ direction: "outbound", cause: err }),
          ),
        );
        yield* recordFrame(inbound, "outbound", raw, frame);
      });

    return {
      connectionId,
      remoteAddr,
      inbound,
      emitEvent: (event) => emit(event as AnyFrame),
      emitResponse: (response) => emit(response as AnyFrame),
      emitMalformed: (opts) =>
        Effect.gen(function* () {
          const base: AnyFrame = opts.baseEvent as AnyFrame;
          const raw = malformFrame(base, opts.kind, opts.seed);
          yield* writer(raw).pipe(
            Effect.mapError(
              (err) =>
                new TransportIoError({ direction: "outbound", cause: err }),
            ),
          );
          yield* recordMalformed(inbound, raw, opts.kind);
        }),
      close: (opts) =>
        writer(new Socket.CloseEvent(opts.code, opts.reason)).pipe(
          Effect.mapError(
            (err) =>
              new TransportClosedError({
                direction: "outbound",
                code: opts.code,
                reason: `${opts.reason}: ${String(err)}`,
              }),
          ),
        ),
    } satisfies TestServerConnection;
  });
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
    const serverState = yield* Ref.make<ReadonlyArray<TestServerConnection>>(
      [],
    );
    const acceptQueue = yield* Ref.make<ReadonlyArray<TestServerConnection>>(
      [],
    );

    const server = yield* NodeSocketServer.makeWebSocket({
      port: config.port,
      host: config.host,
    }).pipe(
      Effect.mapError(
        (err) => new TransportIoError({ direction: "inbound", cause: err }),
      ),
    );

    // Fork the accept loop into the ambient scope; scope closure tears down
    // the listener and every per-connection fiber.
    yield* Effect.forkScoped(
      server
        .run((sock) =>
          Effect.gen(function* () {
            const writer = yield* sock.writer;
            const conn = yield* makeConnection(
              writer as Writer,
              config.captureCapacity,
              "",
            );
            yield* Ref.update(serverState, (s) => [...s, conn]);
            yield* Ref.update(acceptQueue, (q) => [...q, conn]);
            yield* sock.runRaw((data) =>
              Effect.gen(function* () {
                const raw =
                  typeof data === "string"
                    ? data
                    : new TextDecoder("utf-8").decode(data);
                const decoded = yield* Effect.either(
                  decodeFrame(raw, "inbound"),
                );
                if (decoded._tag === "Left") {
                  yield* recordMalformed(conn.inbound, raw, "bit-flip");
                  return;
                }
                yield* recordFrame(conn.inbound, "inbound", raw, decoded.right);
              }),
            );
          }),
        )
        .pipe(Effect.ignore),
    );

    const addr = server.address;
    if (addr._tag !== "TcpAddress") {
      return yield* Effect.fail(
        new TransportIoError({
          direction: "inbound",
          cause: new Error(`expected TcpAddress, got ${addr._tag}`),
        }),
      );
    }
    const wsUrl = `ws://${addr.hostname}:${addr.port}`;

    const accept: Effect.Effect<TestServerConnection, TransportIoError> =
      Effect.gen(function* () {
        while (true) {
          const q = yield* Ref.get(acceptQueue);
          if (q.length > 0) {
            const [next, ...rest] = q;
            yield* Ref.set(acceptQueue, rest);
            if (next !== undefined) return next;
          }
          yield* Effect.sleep("10 millis");
        }
      });

    const allInbound = yield* mergeCaptures([]);

    const snapshot: Effect.Effect<ReadonlyArray<CapturedFrame>> = Effect.gen(
      function* () {
        const conns = yield* Ref.get(serverState);
        const snaps = yield* Effect.forEach(conns, (c) => c.inbound.snapshot, {
          concurrency: "unbounded",
        });
        return snaps.flat();
      },
    );

    return {
      wsUrl,
      accept,
      connections: Ref.get(serverState),
      allInbound,
      snapshot,
    } satisfies TestServer;
  });
}
