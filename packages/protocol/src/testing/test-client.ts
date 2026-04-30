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
  Cause,
  Chunk,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  HashMap,
  Option,
  Ref,
  Scope,
  Stream,
} from "effect";
import * as Socket from "@effect/platform/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import type { RpcMap, RpcMethodName } from "../rpc-registry.js";
import type { EventFrame } from "../schema/frames.js";
import { responseFrame } from "../helpers.js";
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

  // ── PHASE 1.6 STUBS — server-initiated RPC test surface (B.0 architect) ──
  //
  // `handleServerRpc(method, handler)` registers a handler for a server-
  // initiated RPC method. When `handleInbound` (line ~181) sees a `request`
  // frame with `direction: "s2c"`, it looks up the handler, runs it as an
  // Effect, encodes the response, and writes back over the WS.
  //
  // `awaitServerRequest(method, predicate?)` lets a test inspect the inbound
  // request payload BEFORE replying — used to assert e.g. the multi-app
  // FIFO short-circuit (the test must verify the FIRST app's request landed
  // and the SECOND app's did not).
  //
  // Implementer (B.7): the inbound dispatch in `handleInbound` currently
  // routes only `response` and `event`. Add a third branch for
  // `frame.type === "request"` that:
  //   1. Looks up the registered handler by `frame.method` in a
  //      `Ref<Map<string, Handler>>`.
  //   2. Decodes `params` against the s2c method's params schema.
  //   3. Runs the handler as an Effect.
  //   4. Encodes a response frame with `direction: "s2c"` and `id =
  //      frame.id`, writes it over the socket.
  //   5. Records both inbound request and outbound response in `captures`.
  //
  // Type ergonomics: the stub uses `string` for the method name; B.7 narrows
  // to a `S2cRpcMethodName` union once `s2cRpcMethods` exists in
  // `rpc-registry.ts`.

  readonly handleServerRpc: (
    method: string,
    handler: (params: unknown) => Effect.Effect<unknown, RpcResponseError>,
  ) => Effect.Effect<void>;

  readonly awaitServerRequest: (
    method: string,
    predicate?: (params: unknown) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<unknown, Error>;
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

    // Per-method registry of server-initiated RPC handlers. The handler
    // returns `Effect<unknown, RpcResponseError>` — successes encode as
    // `result`, typed errors encode as `error`. Defects collapse to a
    // generic InternalError reply so the server's `Deferred.await` never
    // hangs on a crashing test handler.
    type S2cHandler = (
      params: unknown,
    ) => Effect.Effect<unknown, RpcResponseError>;
    const s2cHandlersRef = yield* Ref.make<HashMap.HashMap<string, S2cHandler>>(
      HashMap.empty(),
    );

    // `awaitServerRequest` is an observation primitive — it parks a
    // `Deferred<inbound params>`, then `notifyAwaiters` fans out the
    // inbound params to the matching deferred AND `dispatchHandler` still
    // runs (so the handler replies). Awaiters and handlers fire
    // independently. Multiple awaiters per method are registration-order
    // FIFO; the predicate filter narrows to the first request whose
    // params satisfy it.
    interface AwaitEntry {
      readonly predicate?: (params: unknown) => boolean;
      readonly deferred: Deferred.Deferred<unknown, Error>;
    }
    const awaitersRef = yield* Ref.make<
      HashMap.HashMap<string, ReadonlyArray<AwaitEntry>>
    >(HashMap.empty());

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
          // c2s response (server's reply to a TestClient-initiated RPC).
          // s2c responses (the TestClient's reply to the server's
          // request) never arrive inbound — TestClient is the originator
          // of c2s, the responder for s2c.
          if (frame.direction !== "c2s") return;
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
        if (frame.type === "request") {
          // s2c request (server-initiated). Architect plan §3.6 third
          // dispatch branch: notify any `awaitServerRequest` observer
          // that matches, then run the registered handler (if any) and
          // write the response back. Both legs are independent — the
          // observer fires regardless of whether a handler is registered.
          if (frame.direction !== "s2c") return;
          yield* notifyAwaiters(frame.method, frame.params);
          yield* dispatchHandler(frame.id, frame.method, frame.params);
          return;
        }
        if (frame.type === "event") {
          yield* Ref.update(eventQueue, (q) => [...q, frame as EventFrame]);
        }
      });

    // ── handleServerRpc / awaitServerRequest internals ────────────────
    //
    // `dispatchHandler` looks up the registered handler in
    // `s2cHandlersRef`, runs it as an Effect, and writes the response.
    // Defects (untagged crashes) collapse to a generic InternalError so
    // the server's `Deferred.await` never hangs.

    const dispatchHandler = (
      requestId: string,
      method: string,
      params: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const handlers = yield* Ref.get(s2cHandlersRef);
        const lookup = HashMap.get(handlers, method);

        const buildReply =
          lookup._tag === "None"
            ? Effect.succeed(
                responseFrame("s2c", requestId, {
                  error: {
                    code: -32601,
                    message: `No handler registered for method: ${method}`,
                  },
                }),
              )
            : lookup.value(params).pipe(
                Effect.match({
                  onSuccess: (result) =>
                    responseFrame("s2c", requestId, { result }),
                  onFailure: (err) =>
                    responseFrame("s2c", requestId, {
                      error: {
                        code: err.code,
                        message: err.message,
                        ...(err.data !== undefined ? { data: err.data } : {}),
                      },
                    }),
                }),
                Effect.catchAllCause((cause) =>
                  Effect.succeed(
                    responseFrame("s2c", requestId, {
                      error: {
                        code: -32603,
                        message: `Handler defected: ${Cause.pretty(cause).slice(0, 200)}`,
                      },
                    }),
                  ),
                ),
              );

        const reply = yield* buildReply;
        const raw = JSON.stringify(reply);
        yield* recordFrame(captures, "outbound", raw, reply as AnyFrame);
        yield* writeFrame(raw).pipe(Effect.ignore);
      });

    const notifyAwaiters = (
      method: string,
      params: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const matched = yield* Ref.modify(awaitersRef, (m) => {
          const bucket = HashMap.get(m, method);
          if (Option.isNone(bucket)) return [Option.none<AwaitEntry>(), m];
          const idx = bucket.value.findIndex(
            (e) => e.predicate === undefined || e.predicate(params),
          );
          if (idx === -1) return [Option.none<AwaitEntry>(), m];
          const chosen = bucket.value[idx]!;
          const rest = [
            ...bucket.value.slice(0, idx),
            ...bucket.value.slice(idx + 1),
          ];
          const next =
            rest.length === 0
              ? HashMap.remove(m, method)
              : HashMap.set(m, method, rest);
          return [Option.some(chosen), next];
        });
        if (Option.isNone(matched)) return;
        yield* Deferred.succeed(matched.value.deferred, params).pipe(
          Effect.ignore,
        );
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
          direction: "c2s",
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
          direction: "c2s",
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

    const handleServerRpc: TestClient["handleServerRpc"] = (method, handler) =>
      Ref.update(s2cHandlersRef, (m) =>
        HashMap.set(m, method, handler as S2cHandler),
      );

    const awaitServerRequest: TestClient["awaitServerRequest"] = (
      method,
      predicate,
      timeoutMs = 5_000,
    ) =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<unknown, Error>();
        const entry: AwaitEntry = predicate
          ? { predicate, deferred }
          : { deferred };
        yield* Ref.update(awaitersRef, (m) => {
          const bucket = HashMap.get(m, method);
          const next =
            bucket._tag === "Some" ? [...bucket.value, entry] : [entry];
          return HashMap.set(m, method, next as ReadonlyArray<AwaitEntry>);
        });
        return yield* Deferred.await(deferred).pipe(
          Effect.timeoutFail({
            duration: Duration.millis(timeoutMs),
            onTimeout: () =>
              new Error(
                `Timeout waiting for server-initiated request: ${method}`,
              ),
          }),
          Effect.onExit((exit) =>
            exit._tag === "Failure"
              ? Ref.update(awaitersRef, (m) => {
                  const bucket = HashMap.get(m, method);
                  if (Option.isNone(bucket)) return m;
                  const filtered = bucket.value.filter((e) => e !== entry);
                  return filtered.length === 0
                    ? HashMap.remove(m, method)
                    : HashMap.set(m, method, filtered);
                })
              : Effect.void,
          ),
        );
      });

    const client: TestClient = {
      sendRpc,
      sendMalformed,
      events,
      captures,
      snapshot: captures.snapshot,
      waitForEvent,
      drainEvents: Ref.getAndSet(eventQueue, []),
      handleServerRpc,
      awaitServerRequest,
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
