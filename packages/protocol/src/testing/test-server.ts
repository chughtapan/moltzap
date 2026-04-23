/**
 * TestServer — accepts real client WebSocket connections and lets property
 * code script arbitrary server-side traffic (valid events, malformed
 * frames, delayed / out-of-order sequences).
 *
 * Per D1 (WS-only) and Invariant I1, TestServer listens on a real
 * `http.Server` + WS upgrade handler (same shape as
 * `packages/server/src/app/server.ts`). TestServer is *not* an
 * in-process counterpart of TestClient; it exists to exercise real client
 * code (`packages/client`, `openclaw-channel`, `nanoclaw-channel`, arena).
 *
 * Satisfies AC3. Consumed by Tier A (A2), Tier B (server-emitted event
 * replay), and Tier E E2 (schema-exhaustive fuzz).
 */
import { Context, Effect, Ref, Scope } from "effect";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
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

function makeConnection(
  sock: WsSocket,
  captureCapacity: number,
  remoteAddr: string,
): Effect.Effect<TestServerConnection> {
  return Effect.gen(function* () {
    connectionCounter += 1;
    const connectionId = `conn-${connectionCounter}`;
    const inbound = yield* makeCaptureBuffer({ capacity: captureCapacity });

    sock.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
      const raw = Array.isArray(data)
        ? Buffer.concat(data).toString("utf8")
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString("utf8")
          : (data as Buffer).toString("utf8");
      const decoded = Effect.runSync(
        Effect.either(decodeFrame(raw, "inbound")),
      );
      if (decoded._tag === "Left") {
        Effect.runFork(recordMalformed(inbound, raw, "bit-flip"));
        return;
      }
      Effect.runFork(recordFrame(inbound, "inbound", raw, decoded.right));
    });

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
        try {
          sock.send(raw);
        } catch (err) {
          return yield* Effect.fail(
            new TransportIoError({ direction: "outbound", cause: err }),
          );
        }
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
          try {
            sock.send(raw);
          } catch (err) {
            return yield* Effect.fail(
              new TransportIoError({ direction: "outbound", cause: err }),
            );
          }
          yield* recordMalformed(inbound, raw, opts.kind);
        }),
      close: (opts) =>
        Effect.sync(() => {
          try {
            sock.close(opts.code, opts.reason);
          } catch (err) {
            // Surface as a typed transport-closed — the socket already being
            // closed means close() was a no-op, which is what callers want.
            void err;
          }
        }).pipe(
          Effect.catchAll((err) =>
            Effect.fail(
              new TransportClosedError({
                direction: "outbound",
                code: opts.code,
                reason: String(err),
              }),
            ),
          ),
        ),
    } satisfies TestServerConnection;
  });
}

/**
 * Bind a real `http.Server` + WS upgrade handler. The surrounding `Scope`
 * owns the listener; releasing it closes every open connection, drains
 * captures, and awaits port release.
 */
export function makeTestServer(
  config: TestServerConfig,
): Effect.Effect<TestServer, TransportIoError, Scope.Scope> {
  return Effect.gen(function* () {
    const serverState = yield* Ref.make<ReadonlyArray<TestServerConnection>>(
      [],
    );
    // Accept queue: resolves when a connection is pushed.
    const acceptQueue = yield* Ref.make<ReadonlyArray<TestServerConnection>>(
      [],
    );

    const server = yield* Effect.acquireRelease(
      Effect.async<http.Server, TransportIoError>((resume) => {
        const httpServer = http.createServer();
        const wss = new WebSocketServer({ server: httpServer });
        wss.on("connection", (sock, req) => {
          const remoteAddr = req.socket.remoteAddress ?? "";
          Effect.runFork(
            Effect.gen(function* () {
              const conn = yield* makeConnection(
                sock,
                config.captureCapacity,
                remoteAddr,
              );
              yield* Ref.update(serverState, (s) => [...s, conn]);
              yield* Ref.update(acceptQueue, (q) => [...q, conn]);
            }),
          );
        });
        httpServer.on("error", (err) =>
          resume(
            Effect.fail(
              new TransportIoError({ direction: "inbound", cause: err }),
            ),
          ),
        );
        httpServer.listen(config.port, config.host, () => {
          resume(Effect.succeed(httpServer));
        });
      }),
      (srv) =>
        Effect.async<void>((resume) => {
          srv.close(() => resume(Effect.void));
        }),
    );

    const addr = server.address() as AddressInfo | string | null;
    const port =
      typeof addr === "string" || addr === null ? config.port : addr.port;
    const host =
      typeof addr === "string" || addr === null ? config.host : addr.address;
    const wsUrl = `ws://${host === "::" ? "127.0.0.1" : host}:${port}`;

    const accept: Effect.Effect<TestServerConnection, TransportIoError> =
      Effect.gen(function* () {
        // Poll acceptQueue — deterministic under property runs; could be
        // replaced with a Queue for stricter back-pressure if needed.
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
