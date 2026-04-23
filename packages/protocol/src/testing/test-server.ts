/**
 * TestServer — accepts real client WebSocket connections and lets property
 * code script arbitrary server-side traffic (valid events, malformed
 * frames, delayed / out-of-order sequences).
 *
 * Per D1 (WS-only) and Invariant I1, TestServer listens on a real
 * `NodeHttpServer` + upgrade path (same shape as
 * `packages/server/src/app/server.ts:L320/L513`). TestServer is *not* an
 * in-process counterpart of TestClient; it exists to exercise real client
 * code (`packages/client`, `openclaw-channel`, `nanoclaw-channel`, arena).
 *
 * Satisfies AC3. Consumed by Tier A (A2), Tier B (server-emitted event
 * replay), and Tier E E2 (schema-exhaustive fuzz).
 */
import type { Context, Effect, Scope } from "effect";
import type { EventFrame, ResponseFrame } from "../schema/frames.js";
import type { CapturedFrame, CaptureBuffer } from "./captures.js";
import type { MalformedFrameKind } from "./codec.js";
import type {
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
  /** Ordered frames received from this client. */
  readonly inbound: CaptureBuffer;
  /**
   * Emit a valid event frame to this client. Returns after the bytes are
   * flushed to the socket (not after the client acks — there is no ack).
   */
  readonly emitEvent: (
    event: EventFrame,
  ) => Effect.Effect<void, TransportIoError | FrameSchemaError>;
  /** Emit a typed response to an inbound request-id. */
  readonly emitResponse: (
    response: ResponseFrame,
  ) => Effect.Effect<void, TransportIoError | FrameSchemaError>;
  /** Emit malformed bytes. Tier A / D consumers. */
  readonly emitMalformed: (opts: {
    readonly baseEvent: EventFrame;
    readonly kind: MalformedFrameKind;
    readonly seed: number;
  }) => Effect.Effect<void, TransportIoError>;
  /** Close the socket with a typed close frame. */
  readonly close: (opts: {
    readonly code: number;
    readonly reason: string;
  }) => Effect.Effect<void, TransportClosedError>;
}

export interface TestServer {
  /** Resolved URL the server is listening on (`ws://host:port/ws`). */
  readonly wsUrl: string;
  /**
   * Accept the next incoming connection. Resolves when a client completes
   * the WS upgrade. Composes inside fast-check commands that wait on N
   * parallel real clients.
   */
  readonly accept: Effect.Effect<TestServerConnection, TransportIoError>;
  /** All live connections, keyed by connectionId. */
  readonly connections: Effect.Effect<ReadonlyArray<TestServerConnection>>;
  /** Merge of every connection's inbound capture buffer. */
  readonly allInbound: CaptureBuffer;
  /** Ordered snapshot across all connections. */
  readonly snapshot: Effect.Effect<ReadonlyArray<CapturedFrame>>;
}

export const TestServer: Context.Tag<TestServer, TestServer> = (() => {
  throw new Error("not implemented");
})();

/**
 * Bind a real `http.Server` + WS upgrade handler. The surrounding `Scope`
 * owns the listener; releasing it closes every open connection, drains
 * captures, and awaits port release.
 */
export function makeTestServer(
  config: TestServerConfig,
): Effect.Effect<TestServer, TransportIoError, Scope.Scope> {
  throw new Error("not implemented");
}
