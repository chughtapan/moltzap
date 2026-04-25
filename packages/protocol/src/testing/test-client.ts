/**
 * TestClient — connects to a REAL MoltZap server URL and drives the wire.
 *
 * Per D1 (WS-only) and Invariant I1 (primitives never bypass the wire),
 * every request is serialized and pushed through a real WebSocket transport
 * — `@effect/platform/Socket.makeWebSocket` backed by
 * `@effect/platform-node/NodeSocket.layerWebSocketConstructor` so the wire
 * bytes match `packages/client`'s real production path.
 *
 * Satisfies AC2. Consumed by Tier A / B / C / D / E properties.
 */
import {
  Chunk,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Ref,
  Scope,
  Stream,
} from "effect";
import * as Socket from "@effect/platform/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import type { RpcMap, RpcMethodName } from "../rpc-registry.js";
import type { EventFrame } from "../schema/frames.js";
import { PROTOCOL_VERSION } from "../version.js";
import {
  makeCaptureBuffer,
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
  /**
   * When `true`, send the `auth/connect` handshake automatically after the
   * WS upgrade. Defaults to `true`.
   */
  readonly autoConnect?: boolean;
  /** Quiescence window (ms) for `sendMalformed` to wait for a response. */
  readonly malformedQuiescenceMs?: number;
}

/**
 * Handle surface. Scoped: acquiring the handle opens the WS; releasing the
 * scope closes it. All methods return Effects so property code can compose
 * them inside `Effect.forEach` / `fc.asyncProperty`.
 */
export interface TestClient {
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

  readonly sendMalformed: (opts: {
    readonly baseMethod: RpcMethodName;
    readonly kind: MalformedFrameKind;
    readonly seed: number;
  }) => Effect.Effect<
    RpcResponseError | null,
    TransportClosedError | TransportIoError | FrameSchemaError
  >;

  readonly events: Stream.Stream<EventFrame, TransportClosedError>;
  readonly captures: CaptureBuffer;
  readonly snapshot: Effect.Effect<ReadonlyArray<CapturedFrame>>;
  readonly waitForEvent: (
    eventName: string,
    timeoutMs?: number,
  ) => Effect.Effect<EventFrame, Error>;
  readonly drainEvents: Effect.Effect<ReadonlyArray<EventFrame>>;
}

export interface CloseableTestClient extends TestClient {
  readonly close: Effect.Effect<void, never>;
}

/** Context tag so property code can `Effect.serviceWith(TestClient, …)`. */
export const TestClient = Context.GenericTag<TestClient>(
  "@moltzap/protocol/testing/TestClient",
);

type PendingMap = Map<
  string,
  Deferred.Deferred<AnyFrame, RpcResponseError | TransportClosedError>
>;

interface CloseState {
  readonly closed: boolean;
  readonly code: number;
  readonly reason: string;
}

let requestIdCounter = 0;

function nextRequestId(): string {
  requestIdCounter += 1;
  return `tc-${Date.now().toString(36)}-${requestIdCounter.toString(36)}`;
}

/**
 * Open a real WS connection to `config.serverUrl`, complete the `connect`
 * handshake, and yield a `TestClient`. The surrounding `Scope` owns the
 * socket; releasing it closes the WS and drains captures.
 */
export function makeTestClient(
  config: TestClientConfig,
): Effect.Effect<
  TestClient,
  TransportIoError | TransportClosedError | RpcResponseError,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const captures = yield* makeCaptureBuffer({
      capacity: config.captureCapacity,
    });
    const pending: PendingMap = new Map();
    const closeRef = yield* Ref.make<CloseState>({
      closed: false,
      code: 0,
      reason: "",
    });
    const eventQueue = yield* Ref.make<ReadonlyArray<EventFrame>>([]);

    // Acquire the WS socket via @effect/platform. The Node WebSocket
    // constructor layer is provided via `Effect.provide` at each use site
    // so the test harness stays self-contained.
    const socket: Socket.Socket = yield* Socket.makeWebSocket(
      config.serverUrl,
      {
        openTimeout: Duration.millis(config.defaultTimeoutMs),
      },
    ).pipe(
      Effect.provide(NodeSocket.layerWebSocketConstructor),
      Effect.mapError(
        (err) => new TransportIoError({ direction: "outbound", cause: err }),
      ),
    );

    const writer = yield* socket.writer.pipe(
      Effect.mapError(
        (err) => new TransportIoError({ direction: "outbound", cause: err }),
      ),
    );

    const handleInbound = (raw: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const decoded = yield* Effect.either(decodeFrame(raw, "inbound"));
        if (decoded._tag === "Left") {
          yield* recordMalformed(captures, raw, "bit-flip");
          return;
        }
        const frame = decoded.right;
        yield* recordFrame(captures, "inbound", raw, frame);

        if (frame.type === "response") {
          const def = pending.get(frame.id);
          if (def !== undefined) {
            pending.delete(frame.id);
            if (frame.error !== undefined) {
              yield* Deferred.fail(
                def,
                new RpcResponseError({
                  method: "",
                  requestId: frame.id,
                  code: frame.error.code,
                  message: frame.error.message,
                  data: frame.error.data,
                }),
              );
            } else {
              yield* Deferred.succeed(def, frame);
            }
          }
          return;
        }
        if (frame.type === "event") {
          yield* Ref.update(eventQueue, (q) => [...q, frame as EventFrame]);
        }
      });

    // Fork the reader fiber into the ambient scope. `socket.runRaw` yields
    // every received string/bytes chunk; teardown is on scope close.
    yield* Effect.forkScoped(
      socket
        .runRaw((data) => {
          const raw =
            typeof data === "string"
              ? data
              : new TextDecoder("utf-8").decode(data);
          return handleInbound(raw);
        })
        .pipe(
          Effect.catchAllCause((cause) =>
            Effect.gen(function* () {
              const failure = cause.toString();
              yield* Ref.set(closeRef, {
                closed: true,
                code: 1006,
                reason: failure,
              });
              const closedErr = new TransportClosedError({
                direction: "inbound",
                code: 1006,
                reason: failure,
              });
              for (const [id, def] of pending) {
                pending.delete(id);
                yield* Deferred.fail(def, closedErr);
              }
            }),
          ),
        ),
    );

    const writeFrame = (
      raw: string,
    ): Effect.Effect<void, TransportClosedError | TransportIoError> =>
      Effect.gen(function* () {
        const state = yield* Ref.get(closeRef);
        if (state.closed) {
          return yield* Effect.fail(
            new TransportClosedError({
              direction: "outbound",
              code: state.code,
              reason: state.reason,
            }),
          );
        }
        yield* writer(raw).pipe(
          Effect.mapError(
            (err) =>
              new TransportIoError({ direction: "outbound", cause: err }),
          ),
        );
      });

    const sendRpc: TestClient["sendRpc"] = (method, params, opts) =>
      Effect.gen(function* () {
        const id = nextRequestId();
        const timeoutMs = opts?.timeoutMs ?? config.defaultTimeoutMs;
        const request: AnyFrame = {
          type: "request",
          jsonrpc: "2.0",
          id,
          method,
          params,
        };
        const raw = encodeFrame(request);
        const deferred = yield* Deferred.make<
          AnyFrame,
          RpcResponseError | TransportClosedError
        >();
        pending.set(id, deferred);
        yield* recordFrame(captures, "outbound", raw, request);
        yield* writeFrame(raw);
        const result = yield* Deferred.await(deferred).pipe(
          Effect.timeoutFail({
            duration: Duration.millis(timeoutMs),
            onTimeout: () =>
              new RpcTimeoutError({ method, requestId: id, timeoutMs }),
          }),
          Effect.ensuring(
            Effect.sync(() => {
              pending.delete(id);
            }),
          ),
        );
        if (result.type !== "response") {
          return yield* Effect.fail(
            new FrameSchemaError({
              direction: "inbound",
              expected: "response",
              raw: encodeFrame(result),
              reason: "expected response frame for rpc reply",
            }),
          );
        }
        return result.result as RpcMap[typeof method]["result"];
      });

    const takeEvent = (eventName: string): Effect.Effect<EventFrame | null> =>
      Ref.modify(eventQueue, (events) => {
        const idx = events.findIndex((event) => event.event === eventName);
        if (idx === -1) return [null, events];
        const event = events[idx]!;
        return [event, [...events.slice(0, idx), ...events.slice(idx + 1)]];
      });

    const waitForEvent: TestClient["waitForEvent"] = (
      eventName,
      timeoutMs = 5000,
    ) =>
      Effect.gen(function* () {
        while (true) {
          const event = yield* takeEvent(eventName);
          if (event !== null) return event;

          const state = yield* Ref.get(closeRef);
          if (state.closed) {
            return yield* Effect.fail(
              new Error(
                `Connection closed while waiting for event: ${eventName}`,
              ),
            );
          }

          yield* Effect.sleep(Duration.millis(10));
        }
      }).pipe(
        Effect.timeoutFail({
          duration: Duration.millis(timeoutMs),
          onTimeout: () => new Error(`Timeout waiting for event: ${eventName}`),
        }),
      );

    /**
     * Send malformed bytes and await the server's reaction. Registers the
     * request id in `pending` so a typed `RpcResponseError` surfaces
     * through the same path as valid RPCs; if the server drops the frame
     * without responding, resolves `null` after the quiescence window.
     *
     * The distinction is observable: `null` means "drop" (the property
     * should assert no state poisoning followed); a returned
     * `RpcResponseError` means the server parsed enough to reply with a
     * typed error. Either is acceptable per Tier A4's contract.
     */
    const sendMalformed: TestClient["sendMalformed"] = (opts) =>
      Effect.gen(function* () {
        const id = nextRequestId();
        const baseFrame: AnyFrame = {
          type: "request",
          jsonrpc: "2.0",
          id,
          method: opts.baseMethod,
          params: {},
        };
        const raw = malformFrame(baseFrame, opts.kind, opts.seed);
        const deferred = yield* Deferred.make<
          AnyFrame,
          RpcResponseError | TransportClosedError
        >();
        pending.set(id, deferred);
        yield* recordMalformed(captures, raw, opts.kind);
        yield* writeFrame(raw);

        const waitMs = config.malformedQuiescenceMs ?? 500;

        // Race the pending Deferred against a quiescence timeout. Clean up
        // the pending entry on both legs so no slot leaks when the server
        // drops silently.
        const outcome = yield* Effect.raceFirst(
          Deferred.await(deferred).pipe(
            Effect.matchEffect({
              onSuccess: () => Effect.succeed(null as RpcResponseError | null),
              onFailure: (err) =>
                err._tag === "TestingRpcResponseError"
                  ? Effect.succeed(err as RpcResponseError | null)
                  : Effect.fail(err),
            }),
          ),
          Effect.succeed(null as RpcResponseError | null).pipe(
            Effect.delay(Duration.millis(waitMs)),
          ),
        ).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              pending.delete(id);
            }),
          ),
        );
        return outcome;
      });

    // Event stream — repeatedly drain `eventQueue`, ending when the WS closes.
    const events: Stream.Stream<EventFrame, TransportClosedError> =
      Stream.unwrap(
        Effect.sync(() => {
          const pullOne: Effect.Effect<
            ReadonlyArray<EventFrame>,
            TransportClosedError
          > = Effect.gen(function* () {
            while (true) {
              const state = yield* Ref.get(closeRef);
              if (state.closed) {
                return yield* Effect.fail(
                  new TransportClosedError({
                    direction: "inbound",
                    code: state.code,
                    reason: state.reason,
                  }),
                );
              }
              const q = yield* Ref.getAndSet(eventQueue, []);
              if (q.length > 0) return q;
              yield* Effect.sleep(Duration.millis(10));
            }
          });
          return Stream.repeatEffectChunk(
            pullOne.pipe(Effect.map((arr) => Chunk.fromIterable(arr))),
          );
        }),
      );

    const client: TestClient = {
      sendRpc,
      sendMalformed,
      events,
      captures,
      snapshot: captures.snapshot,
      waitForEvent,
      drainEvents: Ref.getAndSet(eventQueue, []),
    };

    // Auto-connect handshake (auth/connect). Matches packages/client's
    // real shape — `agentKey` + `minProtocol` + `maxProtocol`. Tolerant
    // of typed rejections so properties that explicitly drive
    // unauthenticated traffic (e.g., authority-negative) can skip
    // autoConnect without the acquire path faulting.
    if (config.autoConnect !== false) {
      const handshakeParams: RpcMap["auth/connect"]["params"] = {
        agentKey: config.agentKey,
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
      };
      const handshake = sendRpc("auth/connect", handshakeParams).pipe(
        Effect.catchTag("TestingRpcTimeoutError", () => Effect.void),
        Effect.catchTag("TestingFrameSchemaError", () => Effect.void),
        Effect.catchTag("TestingRpcResponseError", () => Effect.void),
      );
      yield* handshake;
    }

    return client;
  });
}

export function makeCloseableTestClient(
  config: TestClientConfig,
): Effect.Effect<
  CloseableTestClient,
  TransportIoError | TransportClosedError | RpcResponseError
> {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    const client = yield* Scope.extend(makeTestClient(config), scope);
    return {
      ...client,
      close: Scope.close(scope, Exit.void),
    };
  });
}
