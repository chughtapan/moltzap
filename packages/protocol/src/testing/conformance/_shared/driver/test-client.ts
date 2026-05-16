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
  Data,
  Deferred,
  Duration,
  Effect,
  Either,
  Exit,
  HashMap,
  Option,
  Ref,
  Scope,
  Stream,
} from "effect";
import * as Socket from "@effect/platform/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import type {
  AnyTaskCallbackRpcDefinition,
  AnyRpcDefinition,
} from "../../../../rpc-registry.js";
import { taskCallbackMethods } from "../../../../rpc-registry.js";
import {
  decodeRpcResult,
  type ParamsOf,
  type ResultOf,
} from "../../../../transport/method.js";
import {
  decodeNotification,
  decodeRpcRequest,
  isDecodedNotification,
  type DecodedNotification,
} from "../../../../transport/rpc-groups.js";
import type { ResponseFrame } from "../../../../transport/wire.js";
import { requestFrame, responseFrame } from "../../../../transport/wire.js";
import type { JsonRpcId } from "../../../../transport/wire.js";
import type { AnyNotificationDefinition } from "../../../../rpc-registry.js";
import { notificationDefinitions } from "../../../../rpc-registry.js";
import type { Static } from "@sinclair/typebox";
import { AgentId } from "../../../../identity/methods.js";
import { PROTOCOL_VERSION } from "../../../../version.js";
import {
  makeCaptureBuffer,
  recordFrame,
  recordMalformed,
  type CapturedFrame,
  type CaptureBuffer,
} from "../captures.js";
import {
  decodeFrame,
  encodeFrame,
  isCorrelatedResponseFrame,
  isNotificationFrame,
  isRequestFrame,
  isResponseFrame,
  malformFrame,
  type MalformedFrameKind,
  FrameSchemaError,
} from "../frame-mutator.js";
import {
  RpcResponseError,
  RpcTimeoutError,
  TransportClosedError,
  TransportIoError,
} from "../errors.js";

import { Connect } from "../../../../network/methods.js";

/**
 * Options for connecting a TestClient. `serverUrl` is the `ws://…` URL of
 * the real server; `agentKey` + `agentId` are for the `connect` handshake.
 * `defaultTimeoutMs` bounds each `sendRpc` unless overridden per call.
 */
export interface TestClientConfig {
  readonly serverUrl: string;
  readonly agentKey: string;
  readonly agentId: Static<typeof AgentId>;
  readonly defaultTimeoutMs: number;
  /** Soft cap on captured frames before the ring buffer drops oldest. */
  readonly captureCapacity: number;
  /**
   * When `true`, send the `network/connect` handshake automatically after the
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
  readonly sendRpc: <D extends AnyRpcDefinition>(
    definition: D,
    params: ParamsOf<D>,
    opts?: { readonly timeoutMs?: number },
  ) => Effect.Effect<
    ResultOf<D>,
    | RpcResponseError
    | RpcTimeoutError
    | TransportClosedError
    | TransportIoError
    | FrameSchemaError
  >;

  readonly sendMalformed: <D extends AnyRpcDefinition>(opts: {
    readonly baseDefinition: D;
    readonly baseParams: ParamsOf<D>;
    readonly kind: MalformedFrameKind;
    readonly seed: number;
  }) => Effect.Effect<
    RpcResponseError | null,
    TransportClosedError | TransportIoError | FrameSchemaError
  >;

  /**
   * Wire-level injection seam for properties that need to send a frame
   * the typed `sendRpc` / `sendMalformed` paths cannot produce — e.g. a
   * JSON-RPC response frame whose `id` matches no pending request the
   * server tracks (the `spurious-app-callback-frame-handling` property).
   * The frame is JSON-stringified and written verbatim; no `pending`
   * registration, no schema-encoding, no decoded capture.
   */
  readonly sendRawFrame: (
    frame: unknown,
  ) => Effect.Effect<void, TransportClosedError | TransportIoError>;

  readonly notifications: Stream.Stream<
    DecodedNotification<AnyNotificationDefinition>,
    TransportClosedError
  >;
  readonly captures: CaptureBuffer;
  readonly snapshot: Effect.Effect<ReadonlyArray<CapturedFrame>>;
  readonly waitForNotification: <D extends AnyNotificationDefinition>(
    definition: D,
    timeoutMs?: number,
  ) => Effect.Effect<DecodedNotification<D>, NotificationWaitError>;
  readonly drainNotifications: Effect.Effect<
    ReadonlyArray<DecodedNotification<AnyNotificationDefinition>>
  >;

  /**
   * Register a handler for an app-callback RPC.
   * When `handleInbound` sees a request frame whose method matches, the
   * handler runs and its outcome is encoded as the JSON-RPC response:
   *   - `Effect.succeed(value)` → `{ result: value }`
   *   - `Effect.fail(err: RpcResponseError)` → `{ error: { code, message, data? } }`
   *   - defects collapse to a generic `-32603 InternalError` reply so the
   *     server's `Deferred.await` cannot hang on a crashing handler.
   *
   * Re-registration replaces the prior handler (later wins) — mirrors
   * `HashMap.set`. The TestClient does NOT raise on duplicates the way the
   * production client does; tests routinely swap behaviour mid-scenario.
   *
   * `M` constrains to the registered app-callback method names and
   * `params`/`result` bind to the matching descriptor.
   */
  readonly handleServerRpc: <D extends ServerRpcDefinition>(
    definition: D,
    handler: (
      params: ServerRpcParams<D>,
      ctx: ServerRpcContext,
    ) => Effect.Effect<ServerRpcResult<D>, RpcResponseError>,
  ) => Effect.Effect<void>;

  /**
   * Park until the server sends an app-callback request for `method`. The handler
   * registered via {@link handleServerRpc} (if any) still runs and replies;
   * `awaitServerRequest` is an OBSERVATION primitive — it lets a test
   * assert the request payload before the response goes back without
   * stealing the dispatch.
   *
   * `predicate` narrows to the first request whose params satisfy it.
   * Multiple awaiters per method form a FIFO queue (registration order).
   *
   * `timeoutMs` defaults to 5_000; callers wanting to drive timing
   * themselves can pass a generous value here and gate the returned
   * Effect with `Effect.timeout` at the call site (architect plan §3.6
   * "Effect.timeout at call site, not schema cap").
   */
  readonly awaitServerRequest: <D extends ServerRpcDefinition>(
    definition: D,
    predicate?: (params: ServerRpcParams<D>) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<ServerRpcParams<D>, ServerRequestWaitError>;
}

export class NotificationWaitError extends Data.TaggedError(
  "TestingNotificationWaitError",
)<{
  readonly definition: AnyNotificationDefinition;
  readonly message: string;
  readonly reason: "closed" | "timeout";
}> {}

export class ServerRequestWaitError extends Data.TaggedError(
  "TestingServerRequestWaitError",
)<{
  readonly message: string;
  readonly definition: ServerRpcDefinition;
  readonly reason: "timeout";
}> {}

/**
 * Descriptor constraint for app-callback RPC test surface.
 */
export type ServerRpcDefinition = AnyTaskCallbackRpcDefinition;

/**
 * Inbound params type for an app-callback method.
 */
export type ServerRpcParams<D extends ServerRpcDefinition> = ParamsOf<D>;

/**
 * Outbound result type for an app-callback method handler.
 */
export type ServerRpcResult<D extends ServerRpcDefinition> = ResultOf<D>;

export interface ServerRpcContext {
  readonly requestId: JsonRpcId;
  readonly definition: ServerRpcDefinition;
}

export interface CloseableTestClient extends TestClient {
  readonly close: Effect.Effect<void, never>;
}

/** Context tag so property code can `Effect.serviceWith(TestClient, …)`. */
export const TestClient = Context.GenericTag<TestClient>(
  "@moltzap/protocol/testing/TestClient",
);

type PendingMap = Map<
  JsonRpcId,
  Deferred.Deferred<ResponseFrame, RpcResponseError | TransportClosedError>
>;

interface CloseState {
  readonly closed: boolean;
  readonly code: number;
  readonly reason: string;
}

let requestIdCounter = 0;

const DEFAULT_AWAIT_SERVER_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_MALFORMED_QUIESCENCE_MS = 500;
const DEFAULT_WAIT_FOR_NOTIFICATION_TIMEOUT_MS = 5_000;
const HANDLER_DEFECT_MESSAGE_LIMIT = 200;
const POLL_INTERVAL_MS = 10;
const REQUEST_ID_RADIX = 36;

const outboundTransportIoError = (cause: unknown): TransportIoError =>
  new TransportIoError({ direction: "outbound", cause });

const inboundFrameSchemaError = (
  raw: string,
  reason: string,
): FrameSchemaError =>
  new FrameSchemaError({
    direction: "inbound",
    expected: "response",
    raw,
    reason,
  });

function nextRequestId(): string {
  requestIdCounter += 1;
  return `tc-${Date.now().toString(REQUEST_ID_RADIX)}-${requestIdCounter.toString(REQUEST_ID_RADIX)}`;
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
    const notificationQueue = yield* Ref.make<
      ReadonlyArray<DecodedNotification<AnyNotificationDefinition>>
    >([]);

    // Per-method registry of server-initiated RPC handlers. The handler
    // returns `Effect<unknown, RpcResponseError>` — successes encode as
    // `result`, typed errors encode as `error`. Defects collapse to a
    // generic InternalError reply so the server's `Deferred.await` never
    // hangs on a crashing test handler.
    //
    // The internal type is intentionally `unknown → unknown`: handlers
    // registered via the typed `handleServerRpc` overload are widened
    // at the registration boundary so the dispatcher can dispatch by
    // descriptor identity regardless of which method-specific shape was
    // registered. Type narrowing is restored at the public surface.
    type AppCallbackHandler = (
      params: unknown,
      ctx: ServerRpcContext,
    ) => Effect.Effect<unknown, RpcResponseError>;
    const appCallbackHandlersRef = yield* Ref.make<
      HashMap.HashMap<ServerRpcDefinition, AppCallbackHandler>
    >(HashMap.empty());

    // `awaitServerRequest` is an observation primitive — it parks a
    // `Deferred<inbound params>`, then `notifyAwaiters` fans out the
    // inbound params to the matching deferred AND `dispatchHandler` still
    // runs (so the handler replies). Awaiters and handlers fire
    // independently. Multiple awaiters per method are registration-order
    // FIFO; the predicate filter narrows to the first request whose
    // params satisfy it.
    interface AwaitEntry {
      readonly predicate?: (params: unknown) => boolean;
      readonly deferred: Deferred.Deferred<unknown, ServerRequestWaitError>;
    }
    const awaitersRef = yield* Ref.make<
      HashMap.HashMap<ServerRpcDefinition, ReadonlyArray<AwaitEntry>>
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
      Effect.mapError(outboundTransportIoError),
    );

    const writer = yield* socket.writer.pipe(
      Effect.mapError(outboundTransportIoError),
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
        yield* writer(raw).pipe(Effect.mapError(outboundTransportIoError));
      });

    const handleInbound = (raw: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const frame = yield* decodeFrame(raw, "inbound").pipe(
          Effect.either,
          Effect.flatMap(
            Either.match({
              onLeft: () =>
                recordMalformed(captures, raw, "bit-flip").pipe(
                  Effect.as(null),
                ),
              onRight: (value) => Effect.succeed(value),
            }),
          ),
        );
        if (frame === null) return;
        yield* recordFrame(captures, "inbound", raw, frame);

        if (isResponseFrame(frame)) {
          if (!isCorrelatedResponseFrame(frame)) return;
          const responseId = frame.id;
          const def = pending.get(responseId);
          if (def !== undefined) {
            pending.delete(responseId);
            if ("error" in frame) {
              yield* Deferred.fail(
                def,
                new RpcResponseError({
                  method: "",
                  requestId: responseId,
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
        if (isRequestFrame(frame)) {
          // Server-initiated request. Architect plan §3.6 third
          // dispatch branch: notify any `awaitServerRequest` observer
          // that matches, then run the registered handler (if any) and
          // write the response back. Both legs are independent — the
          // observer fires regardless of whether a handler is registered.
          yield* decodeRpcRequest(taskCallbackMethods, frame).pipe(
            Effect.matchEffect({
              onFailure: () =>
                writeReply(
                  responseFrame(frame.id, {
                    error: {
                      code: -32601,
                      message:
                        "Invalid app-callback request descriptor or params",
                    },
                  }),
                ),
              onSuccess: (request) =>
                Effect.gen(function* () {
                  yield* notifyAwaiters(request.definition, request.params);
                  yield* dispatchHandler(
                    request.id,
                    request.definition,
                    request.params,
                  );
                }),
            }),
          );
          return;
        }
        if (isNotificationFrame(frame)) {
          yield* decodeNotification(notificationDefinitions, frame).pipe(
            Effect.matchEffect({
              onFailure: () => Effect.void,
              onSuccess: (notification) =>
                Ref.update(notificationQueue, (q) => [...q, notification]),
            }),
          );
        }
      });

    // ── handleServerRpc / awaitServerRequest internals ────────────────
    //
    // `dispatchHandler` looks up the registered handler in
    // `appCallbackHandlersRef`, runs it as an Effect, and writes the response.
    // Defects (untagged crashes) collapse to a generic InternalError so
    // the server's `Deferred.await` never hangs.

    const writeReply = (reply: ResponseFrame): Effect.Effect<void> => {
      const raw = JSON.stringify(reply);
      return recordFrame(captures, "outbound", raw, reply).pipe(
        Effect.zipRight(writeFrame(raw).pipe(Effect.ignore)),
      );
    };

    const dispatchHandler = (
      requestId: JsonRpcId,
      definition: ServerRpcDefinition,
      params: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const handlers = yield* Ref.get(appCallbackHandlersRef);
        const lookup = HashMap.get(handlers, definition);

        const buildReply =
          lookup._tag === "None"
            ? Effect.succeed(
                responseFrame(requestId, {
                  error: {
                    code: -32601,
                    message: `No handler registered for app callback descriptor ${definition.name}`,
                  },
                }),
              )
            : lookup.value(params, { requestId, definition }).pipe(
                Effect.match({
                  onSuccess: (result) => responseFrame(requestId, { result }),
                  onFailure: (err) =>
                    responseFrame(requestId, {
                      error: {
                        code: err.code,
                        message: err.message,
                        ...(err.data !== undefined ? { data: err.data } : {}),
                      },
                    }),
                }),
                Effect.catchAllCause((cause) =>
                  Effect.succeed(
                    responseFrame(requestId, {
                      error: {
                        code: -32603,
                        message: `Handler defected: ${Cause.pretty(cause).slice(0, HANDLER_DEFECT_MESSAGE_LIMIT)}`,
                      },
                    }),
                  ),
                ),
              );

        const reply = yield* buildReply;
        yield* writeReply(reply);
      });

    const notifyAwaiters = (
      definition: ServerRpcDefinition,
      params: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const matched = yield* Ref.modify(awaitersRef, (m) => {
          const bucket = Option.getOrUndefined(HashMap.get(m, definition));
          if (bucket === undefined) return [undefined, m];
          const idx = bucket.findIndex(
            (e) => e.predicate === undefined || e.predicate(params),
          );
          if (idx === -1) return [undefined, m];
          const chosen = bucket[idx]!;
          const rest = [...bucket.slice(0, idx), ...bucket.slice(idx + 1)];
          const next =
            rest.length === 0
              ? HashMap.remove(m, definition)
              : HashMap.set(m, definition, rest);
          return [chosen, next];
        });
        if (matched === undefined) return;
        yield* Deferred.succeed(matched.deferred, params).pipe(Effect.ignore);
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

    const sendRpc: TestClient["sendRpc"] = (definition, params, opts) =>
      Effect.gen(function* () {
        const method = definition.name;
        const timeoutMs = opts?.timeoutMs ?? config.defaultTimeoutMs;
        const request = requestFrame(nextRequestId(), definition, params);
        const id = request.id;
        const raw = encodeFrame(request);
        const deferred = yield* Deferred.make<
          ResponseFrame,
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
        if (!("result" in result)) {
          return yield* Effect.fail(
            new FrameSchemaError({
              direction: "inbound",
              expected: "response",
              raw: encodeFrame(result),
              reason: "expected response frame for rpc reply",
            }),
          );
        }
        return yield* decodeRpcResult(definition, result.result).pipe(
          Effect.mapError(() =>
            inboundFrameSchemaError(
              encodeFrame(result),
              `invalid result for rpc method ${method}`,
            ),
          ),
        );
      });

    const takeNotification = <D extends AnyNotificationDefinition>(
      definition: D,
    ): Effect.Effect<DecodedNotification<D> | null> =>
      Ref.modify(notificationQueue, (notifications) => {
        for (const [idx, notification] of notifications.entries()) {
          if (!isDecodedNotification(definition, notification)) continue;
          return [
            notification,
            [...notifications.slice(0, idx), ...notifications.slice(idx + 1)],
          ];
        }
        return [null, notifications];
      });

    const waitForNotification: TestClient["waitForNotification"] = (
      definition,
      timeoutMs = DEFAULT_WAIT_FOR_NOTIFICATION_TIMEOUT_MS,
    ) =>
      Effect.gen(function* () {
        while (true) {
          const notification = yield* takeNotification(definition);
          if (notification !== null) return notification;

          const state = yield* Ref.get(closeRef);
          if (state.closed) {
            return yield* Effect.fail(
              new NotificationWaitError({
                definition,
                message: `Connection closed while waiting for notification: ${definition.name}`,
                reason: "closed",
              }),
            );
          }

          yield* Effect.sleep(Duration.millis(POLL_INTERVAL_MS));
        }
      }).pipe(
        Effect.timeoutFail({
          duration: Duration.millis(timeoutMs),
          onTimeout: () =>
            new NotificationWaitError({
              definition,
              message: `Timeout waiting for notification: ${definition.name}`,
              reason: "timeout",
            }),
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
        const baseFrame = requestFrame(
          nextRequestId(),
          opts.baseDefinition,
          opts.baseParams,
        );
        const id = baseFrame.id;
        const raw = malformFrame(baseFrame, opts.kind, opts.seed);
        const deferred = yield* Deferred.make<
          ResponseFrame,
          RpcResponseError | TransportClosedError
        >();
        pending.set(id, deferred);
        yield* recordMalformed(captures, raw, opts.kind);
        yield* writeFrame(raw);

        const waitMs =
          config.malformedQuiescenceMs ?? DEFAULT_MALFORMED_QUIESCENCE_MS;

        // Race the pending Deferred against a quiescence timeout. Clean up
        // the pending entry on both legs so no slot leaks when the server
        // drops silently.
        return yield* Effect.raceFirst(
          Deferred.await(deferred).pipe(
            Effect.matchEffect({
              onSuccess: () => Effect.succeed(null as RpcResponseError | null),
              onFailure: (err) =>
                err instanceof RpcResponseError
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
      });

    const sendRawFrame: TestClient["sendRawFrame"] = (frame) =>
      writeFrame(JSON.stringify(frame));

    // Notification stream — repeatedly drain `notificationQueue`, ending when the WS closes.
    const notifications: Stream.Stream<
      DecodedNotification<AnyNotificationDefinition>,
      TransportClosedError
    > = Stream.unwrap(
      Effect.sync(() => {
        const pullOne: Effect.Effect<
          ReadonlyArray<DecodedNotification<AnyNotificationDefinition>>,
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
            const q = yield* Ref.getAndSet(notificationQueue, []);
            if (q.length > 0) return q;
            yield* Effect.sleep(Duration.millis(POLL_INTERVAL_MS));
          }
        });
        return Stream.repeatEffectChunk(
          pullOne.pipe(Effect.map((arr) => Chunk.fromIterable(arr))),
        );
      }),
    );

    const handleServerRpc: TestClient["handleServerRpc"] = (
      definition,
      handler,
    ) =>
      Ref.update(appCallbackHandlersRef, (m) =>
        HashMap.set(m, definition, handler as AppCallbackHandler),
      );

    const awaitServerRequest: TestClient["awaitServerRequest"] = <
      D extends ServerRpcDefinition,
    >(
      definition: D,
      predicate?: (params: ServerRpcParams<D>) => boolean,
      timeoutMs = DEFAULT_AWAIT_SERVER_REQUEST_TIMEOUT_MS,
    ): Effect.Effect<ServerRpcParams<D>, ServerRequestWaitError> =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<
          unknown,
          ServerRequestWaitError
        >();
        const entry: AwaitEntry = {
          deferred,
          ...(predicate !== undefined
            ? {
                predicate: predicate as (params: unknown) => boolean,
              }
            : {}),
        };
        yield* Ref.update(awaitersRef, (m) => {
          const bucket = HashMap.get(m, definition);
          const next =
            bucket._tag === "Some" ? [...bucket.value, entry] : [entry];
          return HashMap.set(m, definition, next as ReadonlyArray<AwaitEntry>);
        });
        const result = yield* Deferred.await(deferred).pipe(
          Effect.timeoutFail({
            duration: Duration.millis(timeoutMs),
            onTimeout: () =>
              new ServerRequestWaitError({
                message: `Timeout waiting for server-initiated request ${definition.name}`,
                definition,
                reason: "timeout",
              }),
          }),
          Effect.onExit((exit) =>
            exit._tag === "Failure"
              ? Ref.update(awaitersRef, (m) => {
                  const bucket = HashMap.get(m, definition);
                  if (Option.isNone(bucket)) return m;
                  const filtered = bucket.value.filter((e) => e !== entry);
                  return filtered.length === 0
                    ? HashMap.remove(m, definition)
                    : HashMap.set(m, definition, filtered);
                })
              : Effect.void,
          ),
        );
        return result as ServerRpcParams<D>;
      });

    const client: TestClient = {
      sendRpc,
      sendMalformed,
      sendRawFrame,
      notifications,
      captures,
      snapshot: captures.snapshot,
      waitForNotification,
      drainNotifications: Ref.getAndSet(notificationQueue, []),
      handleServerRpc,
      awaitServerRequest,
    };

    // Auto-connect handshake (network/connect). Matches packages/client's
    // real shape — `agentKey` + `minProtocol` + `maxProtocol`. Tolerant
    // of typed rejections so properties that explicitly drive
    // unauthenticated traffic (e.g., authority-negative) can skip
    // autoConnect without the acquire path faulting.
    if (config.autoConnect !== false) {
      const handshakeParams: ParamsOf<typeof Connect> = {
        agentKey: config.agentKey,
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
      };
      const handshake = sendRpc(Connect, handshakeParams).pipe(
        Effect.catchTag("TestingRpcTimeoutError", () => Effect.void),
        Effect.catchTag("TestingFrameSchemaError", () => Effect.void),
        Effect.catchTag("TestingRpcResponseError", () => Effect.void),
      );
      yield* handshake;
    }

    return client;
  }).pipe(Effect.withSpan("makeTestClient"));
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
  }).pipe(Effect.withSpan("makeCloseableTestClient"));
}
