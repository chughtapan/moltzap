/**
 * TestClient — connects to a REAL MoltZap server URL and drives the wire.
 *
 * Per D1 (WS-only) and Invariant I1 (primitives never bypass the wire),
 * every request is serialized and pushed through a real WebSocket transport
 * (`@effect/platform-node/NodeSocket`). The surface is Effect-native so
 * fast-check commands can compose it with `Effect.gen`.
 *
 * Satisfies AC2. Consumed by Tier A / B / C / D / E properties.
 */
import type { Context, Effect, Scope, Stream } from "effect";
import type { RpcMap, RpcMethodName } from "../rpc-registry.js";
import type { EventFrame } from "../schema/frames.js";
import type { CapturedFrame, CaptureBuffer } from "./captures.js";
import type { MalformedFrameKind } from "./codec.js";
import type {
  FrameSchemaError,
  RpcResponseError,
  RpcTimeoutError,
  TransportClosedError,
  TransportIoError,
} from "./errors.js";

/**
 * Options for connecting a TestClient. `serverUrl` is the `ws://…` URL of
 * the real server; `agentKey` + `agentId` are for the `connect` handshake.
 * `defaultTimeoutMs` bounds each `sendRpc` unless overridden per call.
 */
export interface TestClientConfig {
  readonly serverUrl: string;
  readonly agentKey: string;
  readonly agentId: string;
  readonly defaultTimeoutMs: number;
  /** Soft cap on captured frames before the ring buffer drops oldest. */
  readonly captureCapacity: number;
}

/**
 * Handle surface. Scoped: acquiring the handle opens the WS; releasing the
 * scope closes it. All methods return Effects so property code can compose
 * them inside `Effect.forEach` / `fc.asyncProperty`.
 */
export interface TestClient {
  /** Send a valid RPC; receive the typed result or a typed error. */
  readonly sendRpc: <M extends RpcMethodName>(
    method: M,
    params: RpcMap[M]["params"],
    opts?: { readonly timeoutMs?: number },
  ) => Effect.Effect<
    RpcMap[M]["result"],
    | RpcResponseError
    | RpcTimeoutError
    | TransportClosedError
    | TransportIoError
    | FrameSchemaError
  >;

  /**
   * Push malformed bytes on the wire (Tier A / D). Returns the server's
   * observable response — either an `ErrorFrame` or a clean drop
   * (resolves with `null` after the configured quiescence window).
   */
  readonly sendMalformed: (opts: {
    readonly baseMethod: RpcMethodName;
    readonly kind: MalformedFrameKind;
    readonly seed: number;
  }) => Effect.Effect<
    RpcResponseError | null,
    TransportClosedError | TransportIoError | FrameSchemaError
  >;

  /** Inbound event stream (subscriber surface the server emits to). */
  readonly events: Stream.Stream<EventFrame, TransportClosedError>;

  /** Every inbound + outbound frame for this connection. */
  readonly captures: CaptureBuffer;

  /** Ordered snapshot of frames received since connect. */
  readonly snapshot: Effect.Effect<ReadonlyArray<CapturedFrame>>;
}

/** Context tag so property code can `Effect.serviceWith(TestClient, …)`. */
export const TestClient: Context.Tag<TestClient, TestClient> = (() => {
  throw new Error("not implemented");
})();

/**
 * Open a real WS connection to `config.serverUrl`, complete the `connect`
 * handshake, and yield a `TestClient`. The surrounding `Scope` owns the
 * socket; releasing it sends the WS close frame and drains captures.
 */
export function makeTestClient(
  config: TestClientConfig,
): Effect.Effect<
  TestClient,
  TransportIoError | TransportClosedError | RpcResponseError,
  Scope.Scope
> {
  throw new Error("not implemented");
}
