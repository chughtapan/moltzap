/* eslint-disable jsdoc/text-escaping -- generic-type JSDoc references like `Stream.Stream<T>` use the natural angle-bracket form inside backtick code spans; the lint rule's pre-render check fires false positives on these. Matches the precedent in @moltzap/client's notification/stream.ts. */

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
  type NotificationParamsOf,
  type ParamsOf,
  type ResultOf,
} from "../../../../transport/method.js";
import {
  decodeNotification,
  decodeRpcRequest,
  isDecodedNotification,
  type DecodedNotification,
  type DecodedRpcRequest,
} from "../../../../transport/rpc-groups.js";
import type {
  NotificationFrame,
  RequestFrame,
  ResponseFrame,
} from "../../../../transport/wire.js";
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
  type AnyFrame,
  type CorrelatedResponseFrame,
  FrameSchemaError,
  type MalformedFrameKind,
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

  readonly sendResponseFrame: (
    frame: ResponseFrame,
  ) => Effect.Effect<void, TransportClosedError | TransportIoError>;

  // IMPL-DELETION-TARGET (#645): `notifications` / `waitForNotification` /
  // `drainNotifications` are the polling-shape surface deleted by
  // architect #645. Impl replaces with `subscribe` / `subscribeAll` below.
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
   * Typed-payload subscribe (Spec B parity — #645). Returns a Stream of
   * `DecodedNotification<D>` whose error channel is `TransportClosedError`
   * and requirement set is `never`. Optional `refinement` is a typed
   * predicate over the definition's params; the type-guard overload
   * narrows the Stream's payload to `DecodedNotification<D, R>`.
   *
   * Lifecycle: construction is pure (no I/O, no scope); first pull
   * suspends inside `Stream.async` until dispatch fires `emit.single`;
   * terminal `TestClient.close` fires `emit.fail(TransportClosedError)`
   * via the registry's `closeAll`.
   */
  readonly subscribe: {
    <D extends AnyNotificationDefinition>(
      definition: D,
      refinement?: (params: NotificationParamsOf<D>) => boolean,
    ): Stream.Stream<DecodedNotification<D>, TransportClosedError>;
    <D extends AnyNotificationDefinition, R extends NotificationParamsOf<D>>(
      definition: D,
      refinement: (params: NotificationParamsOf<D>) => params is R,
    ): Stream.Stream<DecodedNotification<D, R>, TransportClosedError>;
  };

  /**
   * Broad-union subscribe (Spec B parity — #645). Returns a Stream of
   * every inbound notification regardless of definition. Used by
   * conformance helpers that need to filter on params-shaped predicates
   * (e.g. presence/changed by agentId+status). Payload narrowing is
   * intentionally lost; callers wanting typed payloads use `subscribe`.
   */
  readonly subscribeAll: (
    refinement?: (
      notification: DecodedNotification<AnyNotificationDefinition>,
    ) => boolean,
  ) => Stream.Stream<
    DecodedNotification<AnyNotificationDefinition>,
    TransportClosedError
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

type NotificationQueue = ReadonlyArray<
  DecodedNotification<AnyNotificationDefinition>
>;

type AppCallbackHandler = (
  params: unknown,
  ctx: ServerRpcContext,
) => Effect.Effect<unknown, RpcResponseError>;

interface AwaitEntry {
  readonly predicate?: (params: unknown) => boolean;
  readonly deferred: Deferred.Deferred<unknown, ServerRequestWaitError>;
}

type AwaitersMap = HashMap.HashMap<
  ServerRpcDefinition,
  ReadonlyArray<AwaitEntry>
>;

type ServerRpcRequest = DecodedRpcRequest<ServerRpcDefinition>;

interface CloseState {
  readonly closed: boolean;
  readonly code: number;
  readonly reason: string;
}

type SocketWriter = (
  frame: Uint8Array | string | Socket.CloseEvent,
) => Effect.Effect<void, Socket.SocketError>;

interface TestClientRuntime {
  readonly config: TestClientConfig;
  readonly captures: CaptureBuffer;
  readonly pending: PendingMap;
  readonly closeRef: Ref.Ref<CloseState>;
  readonly notificationQueue: Ref.Ref<NotificationQueue>;
  readonly appCallbackHandlersRef: Ref.Ref<
    HashMap.HashMap<ServerRpcDefinition, AppCallbackHandler>
  >;
  readonly awaitersRef: Ref.Ref<AwaitersMap>;
  readonly socket: Socket.Socket;
  readonly writer: SocketWriter;
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

function appendNotification(
  notification: DecodedNotification<AnyNotificationDefinition>,
): (queue: NotificationQueue) => NotificationQueue {
  return (queue) => [...queue, notification];
}

function awaitEntryMatches(params: unknown, entry: AwaitEntry): boolean {
  return entry.predicate === undefined || entry.predicate(params);
}

function takeMatchingAwaitEntry(
  awaiters: AwaitersMap,
  definition: ServerRpcDefinition,
  params: unknown,
): readonly [AwaitEntry | undefined, AwaitersMap] {
  const bucket = Option.getOrUndefined(HashMap.get(awaiters, definition));
  if (bucket === undefined) return [undefined, awaiters];
  const idx = bucket.findIndex((entry) => awaitEntryMatches(params, entry));
  if (idx === -1) return [undefined, awaiters];
  const chosen = bucket[idx]!;
  const rest = [...bucket.slice(0, idx), ...bucket.slice(idx + 1)];
  const next =
    rest.length === 0
      ? HashMap.remove(awaiters, definition)
      : HashMap.set(awaiters, definition, rest);
  return [chosen, next];
}

function removeAwaitEntry(
  awaiters: AwaitersMap,
  definition: ServerRpcDefinition,
  entry: AwaitEntry,
): AwaitersMap {
  const bucket = HashMap.get(awaiters, definition);
  if (Option.isNone(bucket)) return awaiters;
  const filtered = bucket.value.filter((candidate) => candidate !== entry);
  return filtered.length === 0
    ? HashMap.remove(awaiters, definition)
    : HashMap.set(awaiters, definition, filtered);
}

function removeAwaitEntryOnFailure(
  exit: Exit.Exit<unknown, unknown>,
  awaitersRef: Ref.Ref<AwaitersMap>,
  definition: ServerRpcDefinition,
  entry: AwaitEntry,
): Effect.Effect<void> {
  return exit._tag === "Failure"
    ? Ref.update(awaitersRef, (awaiters) =>
        removeAwaitEntry(awaiters, definition, entry),
      )
    : Effect.void;
}

interface ServerRequestDispatch {
  readonly requestId: JsonRpcId;
  readonly definition: ServerRpcDefinition;
  readonly params: unknown;
}

interface PendingRpcRequest {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly timeoutMs: number;
}

interface SendRpcInput<D extends AnyRpcDefinition> {
  readonly definition: D;
  readonly params: ParamsOf<D>;
  readonly opts?: { readonly timeoutMs?: number };
}

interface AwaitServerRequestInput<D extends ServerRpcDefinition> {
  readonly definition: D;
  readonly predicate?: (params: ServerRpcParams<D>) => boolean;
  readonly timeoutMs: number;
}

type OpenTestClientRuntimeError =
  | TransportIoError
  | TransportClosedError
  | RpcResponseError;

class RuntimeTestClient implements TestClient {
  readonly close?: Effect.Effect<void, never>;
  readonly captures: CaptureBuffer;
  readonly snapshot: Effect.Effect<ReadonlyArray<CapturedFrame>>;
  readonly notifications: Stream.Stream<
    DecodedNotification<AnyNotificationDefinition>,
    TransportClosedError
  >;
  readonly drainNotifications: Effect.Effect<
    ReadonlyArray<DecodedNotification<AnyNotificationDefinition>>
  >;

  constructor(
    private readonly runtime: TestClientRuntime,
    close?: Effect.Effect<void, never>,
  ) {
    if (close !== undefined) {
      this.close = close;
    }
    this.captures = runtime.captures;
    this.snapshot = runtime.captures.snapshot;
    this.notifications = makeNotificationsStream(runtime);
    this.drainNotifications = Ref.getAndSet(runtime.notificationQueue, []);
  }

  sendRpc<D extends AnyRpcDefinition>(
    definition: D,
    params: ParamsOf<D>,
    opts?: { readonly timeoutMs?: number },
  ): ReturnType<TestClient["sendRpc"]> {
    const input =
      opts === undefined
        ? { definition, params }
        : { definition, params, opts };
    return sendClientRpc(this.runtime, input);
  }

  sendMalformed<D extends AnyRpcDefinition>(
    opts: Parameters<TestClient["sendMalformed"]>[0] & {
      readonly baseDefinition: D;
      readonly baseParams: ParamsOf<D>;
    },
  ): ReturnType<TestClient["sendMalformed"]> {
    return sendMalformedFrame(this.runtime, opts);
  }

  sendResponseFrame(
    frame: ResponseFrame,
  ): ReturnType<TestClient["sendResponseFrame"]> {
    return writeOutboundFrame(this.runtime, frame);
  }

  waitForNotification<D extends AnyNotificationDefinition>(
    definition: D,
    timeoutMs?: number,
  ): Effect.Effect<DecodedNotification<D>, NotificationWaitError> {
    const resolvedTimeoutMs =
      timeoutMs ?? DEFAULT_WAIT_FOR_NOTIFICATION_TIMEOUT_MS;
    return waitForNotification(this.runtime, definition, resolvedTimeoutMs);
  }

  // ARCHITECT STUB (#645): `subscribe` + `subscribeAll` are the new
  // Stream.async-backed surface that replaces `notifications` /
  // `waitForNotification` / `drainNotifications`. Impl wires these to
  // `TestSubscriberRegistry` (see ./test-subscribers.ts). Bodies return
  // `Stream.die(...)` so the defect surfaces only at pull time; no
  // caller exercises these in the stub HEAD.
  subscribe<D extends AnyNotificationDefinition>(
    definition: D,
    refinement?: (params: NotificationParamsOf<D>) => boolean,
  ): Stream.Stream<DecodedNotification<D>, TransportClosedError>;
  subscribe<
    D extends AnyNotificationDefinition,
    R extends NotificationParamsOf<D>,
  >(
    definition: D,
    refinement: (params: NotificationParamsOf<D>) => params is R,
  ): Stream.Stream<DecodedNotification<D, R>, TransportClosedError>;
  subscribe<D extends AnyNotificationDefinition>(
    _definition: D,
    _refinement?: (params: NotificationParamsOf<D>) => boolean,
  ): Stream.Stream<DecodedNotification<D>, TransportClosedError> {
    return Stream.die("architect stub (#645)");
  }

  subscribeAll(
    _refinement?: (
      notification: DecodedNotification<AnyNotificationDefinition>,
    ) => boolean,
  ): Stream.Stream<
    DecodedNotification<AnyNotificationDefinition>,
    TransportClosedError
  > {
    return Stream.die("architect stub (#645)");
  }

  handleServerRpc<D extends ServerRpcDefinition>(
    definition: D,
    handler: (
      params: ServerRpcParams<D>,
      ctx: ServerRpcContext,
    ) => Effect.Effect<ServerRpcResult<D>, RpcResponseError>,
  ): Effect.Effect<void> {
    return registerServerRpcHandler(
      this.runtime,
      definition,
      handler as AppCallbackHandler,
    );
  }

  awaitServerRequest<D extends ServerRpcDefinition>(
    definition: D,
    predicate?: (params: ServerRpcParams<D>) => boolean,
    timeoutMs = DEFAULT_AWAIT_SERVER_REQUEST_TIMEOUT_MS,
  ): Effect.Effect<ServerRpcParams<D>, ServerRequestWaitError> {
    const input =
      predicate === undefined
        ? { definition, timeoutMs }
        : { definition, predicate, timeoutMs };
    return awaitServerRequest(this.runtime, input);
  }
}

function acquireTestClientRuntime(
  config: TestClientConfig,
): Effect.Effect<TestClientRuntime, TransportIoError, Scope.Scope> {
  return Effect.gen(function* () {
    const captures = yield* makeCaptureBuffer({
      capacity: config.captureCapacity,
    });
    const closeRef = yield* Ref.make<CloseState>({
      closed: false,
      code: 0,
      reason: "",
    });
    const socket = yield* Socket.makeWebSocket(config.serverUrl, {
      openTimeout: Duration.millis(config.defaultTimeoutMs),
    }).pipe(
      Effect.provide(NodeSocket.layerWebSocketConstructor),
      Effect.mapError(outboundTransportIoError),
    );
    const writer = yield* socket.writer;

    return {
      config,
      captures,
      pending: new Map(),
      closeRef,
      notificationQueue: yield* Ref.make<NotificationQueue>([]),
      appCallbackHandlersRef: yield* Ref.make(
        HashMap.empty<ServerRpcDefinition, AppCallbackHandler>(),
      ),
      awaitersRef: yield* Ref.make(
        HashMap.empty<ServerRpcDefinition, ReadonlyArray<AwaitEntry>>(),
      ),
      socket,
      writer,
    };
  });
}

function openTestClientRuntime(
  config: TestClientConfig,
): Effect.Effect<TestClientRuntime, OpenTestClientRuntimeError, Scope.Scope> {
  return Effect.gen(function* () {
    const runtime = yield* acquireTestClientRuntime(config);
    yield* startSocketReader(runtime);
    if (config.autoConnect !== false) {
      yield* autoConnect(runtime);
    }
    return runtime;
  });
}

function writeFrame(
  runtime: TestClientRuntime,
  raw: string,
): Effect.Effect<void, TransportClosedError | TransportIoError> {
  return Effect.gen(function* () {
    const state = yield* Ref.get(runtime.closeRef);
    if (state.closed) {
      return yield* Effect.fail(
        new TransportClosedError({
          direction: "outbound",
          code: state.code,
          reason: state.reason,
        }),
      );
    }
    yield* runtime.writer(raw).pipe(Effect.mapError(outboundTransportIoError));
  });
}

function writeReply(
  runtime: TestClientRuntime,
  reply: ResponseFrame,
): Effect.Effect<void> {
  return writeOutboundFrame(runtime, reply).pipe(Effect.ignore);
}

function writeOutboundFrame(
  runtime: TestClientRuntime,
  frame: AnyFrame,
): Effect.Effect<void, TransportClosedError | TransportIoError> {
  const raw = encodeFrame(frame);
  return recordFrame(runtime.captures, "outbound", raw, frame).pipe(
    Effect.zipRight(writeFrame(runtime, raw)),
  );
}

function decodeInboundFrame(
  runtime: TestClientRuntime,
  raw: string,
): Effect.Effect<AnyFrame | null> {
  return Effect.gen(function* () {
    return yield* decodeFrame(raw, "inbound").pipe(
      Effect.either,
      Effect.flatMap(
        Either.match({
          onLeft: () =>
            recordMalformed(runtime.captures, raw, "bit-flip").pipe(
              Effect.as(null),
            ),
          onRight: Effect.succeed,
        }),
      ),
    );
  });
}

function handleInbound(
  runtime: TestClientRuntime,
  raw: string,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const frame = yield* decodeInboundFrame(runtime, raw);
    if (frame === null) return;
    yield* recordFrame(runtime.captures, "inbound", raw, frame);
    yield* handleInboundFrame(runtime, frame);
  });
}

function handleInboundFrame(
  runtime: TestClientRuntime,
  frame: AnyFrame,
): Effect.Effect<void> {
  if (isResponseFrame(frame)) return handleResponseFrame(runtime, frame);
  if (isRequestFrame(frame)) return handleRequestFrame(runtime, frame);
  if (isNotificationFrame(frame))
    return handleNotificationFrame(runtime, frame);
  return Effect.void;
}

function handleResponseFrame(
  runtime: TestClientRuntime,
  frame: ResponseFrame,
): Effect.Effect<void> {
  return isCorrelatedResponseFrame(frame)
    ? completePendingResponse(runtime, frame)
    : Effect.void;
}

function completePendingResponse(
  runtime: TestClientRuntime,
  frame: CorrelatedResponseFrame,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const deferred = runtime.pending.get(frame.id);
    if (deferred === undefined) return;
    runtime.pending.delete(frame.id);
    if ("error" in frame) {
      yield* Deferred.fail(
        deferred,
        new RpcResponseError({
          method: "",
          requestId: frame.id,
          code: frame.error.code,
          message: frame.error.message,
          data: frame.error.data,
        }),
      );
      return;
    }
    yield* Deferred.succeed(deferred, frame);
  });
}

function handleRequestFrame(
  runtime: TestClientRuntime,
  frame: RequestFrame,
): Effect.Effect<void> {
  return decodeRpcRequest(taskCallbackMethods, frame).pipe(
    Effect.matchEffect({
      onFailure: () => writeReply(runtime, invalidCallbackRequestReply(frame)),
      onSuccess: (request) => handleDecodedServerRequest(runtime, request),
    }),
  );
}

function invalidCallbackRequestReply(frame: RequestFrame): ResponseFrame {
  return responseFrame(frame.id, {
    error: {
      code: -32601,
      message: "Invalid app-callback request descriptor or params",
    },
  });
}

function handleDecodedServerRequest(
  runtime: TestClientRuntime,
  request: ServerRpcRequest,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* notifyAwaiters(runtime, request.definition, request.params);
    yield* dispatchHandler(runtime, {
      requestId: request.id,
      definition: request.definition,
      params: request.params,
    });
  });
}

function handleNotificationFrame(
  runtime: TestClientRuntime,
  frame: NotificationFrame,
): Effect.Effect<void> {
  return decodeNotification(notificationDefinitions, frame).pipe(
    Effect.matchEffect({
      onFailure: () => Effect.void,
      onSuccess: (notification) => queueNotification(runtime, notification),
    }),
  );
}

function queueNotification(
  runtime: TestClientRuntime,
  notification: DecodedNotification<AnyNotificationDefinition>,
): Effect.Effect<void> {
  return Ref.update(
    runtime.notificationQueue,
    appendNotification(notification),
  );
}

function dispatchHandler(
  runtime: TestClientRuntime,
  request: ServerRequestDispatch,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const reply = yield* buildServerRequestReply(runtime, request);
    yield* writeReply(runtime, reply);
  });
}

function buildServerRequestReply(
  runtime: TestClientRuntime,
  request: ServerRequestDispatch,
): Effect.Effect<ResponseFrame> {
  return Effect.gen(function* () {
    const handlers = yield* Ref.get(runtime.appCallbackHandlersRef);
    const handler = Option.getOrUndefined(
      HashMap.get(handlers, request.definition),
    );
    if (handler === undefined) return missingHandlerReply(request);
    return yield* buildHandlerReply(request, handler);
  });
}

function missingHandlerReply(request: ServerRequestDispatch): ResponseFrame {
  return responseFrame(request.requestId, {
    error: {
      code: -32601,
      message: `No handler registered for app callback descriptor ${request.definition.name}`,
    },
  });
}

function buildHandlerReply(
  request: ServerRequestDispatch,
  handler: AppCallbackHandler,
): Effect.Effect<ResponseFrame> {
  return handler(request.params, {
    requestId: request.requestId,
    definition: request.definition,
  }).pipe(
    Effect.match({
      onSuccess: (result) => responseFrame(request.requestId, { result }),
      onFailure: (err) =>
        responseFrame(request.requestId, {
          error: {
            code: err.code,
            message: err.message,
            ...(err.data !== undefined ? { data: err.data } : {}),
          },
        }),
    }),
    Effect.catchAllCause((cause) =>
      Effect.succeed(handlerDefectedReply(request.requestId, cause)),
    ),
  );
}

function handlerDefectedReply(
  requestId: JsonRpcId,
  cause: Cause.Cause<unknown>,
): ResponseFrame {
  return responseFrame(requestId, {
    error: {
      code: -32603,
      message: `Handler defected: ${Cause.pretty(cause).slice(0, HANDLER_DEFECT_MESSAGE_LIMIT)}`,
    },
  });
}

function notifyAwaiters(
  runtime: TestClientRuntime,
  definition: ServerRpcDefinition,
  params: unknown,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const matched = yield* Ref.modify(runtime.awaitersRef, (awaiters) =>
      takeMatchingAwaitEntry(awaiters, definition, params),
    );
    if (matched === undefined) return;
    yield* Deferred.succeed(matched.deferred, params).pipe(Effect.ignore);
  });
}

function startSocketReader(
  runtime: TestClientRuntime,
): Effect.Effect<void, never, Scope.Scope> {
  const reader = runtime.socket
    .runRaw((data) => handleInbound(runtime, decodeSocketData(data)))
    .pipe(
      Effect.catchAllCause((cause) =>
        handleSocketReaderFailure(runtime, cause),
      ),
    );
  return Effect.forkScoped(reader).pipe(Effect.asVoid);
}

function decodeSocketData(data: string | Uint8Array): string {
  return typeof data === "string"
    ? data
    : new TextDecoder("utf-8").decode(data);
}

function handleSocketReaderFailure(
  runtime: TestClientRuntime,
  cause: Cause.Cause<unknown>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const failure = Cause.pretty(cause);
    yield* Ref.set(runtime.closeRef, {
      closed: true,
      code: 1006,
      reason: failure,
    });
    const closedErr = new TransportClosedError({
      direction: "inbound",
      code: 1006,
      reason: failure,
    });
    for (const [id, deferred] of runtime.pending) {
      runtime.pending.delete(id);
      yield* Deferred.fail(deferred, closedErr);
    }
  });
}

function sendClientRpc<D extends AnyRpcDefinition>(
  runtime: TestClientRuntime,
  input: SendRpcInput<D>,
): Effect.Effect<
  ResultOf<D>,
  | RpcResponseError
  | RpcTimeoutError
  | TransportClosedError
  | TransportIoError
  | FrameSchemaError
> {
  return Effect.gen(function* () {
    const request = requestFrame(
      nextRequestId(),
      input.definition,
      input.params,
    );
    const raw = encodeFrame(request);
    const deferred = yield* Deferred.make<
      ResponseFrame,
      RpcResponseError | TransportClosedError
    >();
    runtime.pending.set(request.id, deferred);
    yield* recordFrame(runtime.captures, "outbound", raw, request);
    yield* writeFrame(runtime, raw);
    const response = yield* awaitPendingRpcResponse(runtime, deferred, {
      id: request.id,
      method: input.definition.name,
      timeoutMs: input.opts?.timeoutMs ?? runtime.config.defaultTimeoutMs,
    });
    return yield* decodeRpcSuccessResult(input.definition, response);
  });
}

function awaitPendingRpcResponse(
  runtime: TestClientRuntime,
  deferred: Deferred.Deferred<
    ResponseFrame,
    RpcResponseError | TransportClosedError
  >,
  request: PendingRpcRequest,
): Effect.Effect<
  ResponseFrame,
  RpcResponseError | RpcTimeoutError | TransportClosedError
> {
  return Deferred.await(deferred).pipe(
    Effect.timeoutFail({
      duration: Duration.millis(request.timeoutMs),
      onTimeout: () =>
        new RpcTimeoutError({
          method: request.method,
          requestId: request.id,
          timeoutMs: request.timeoutMs,
        }),
    }),
    Effect.ensuring(
      Effect.sync(() => {
        runtime.pending.delete(request.id);
      }),
    ),
  );
}

function decodeRpcSuccessResult<D extends AnyRpcDefinition>(
  definition: D,
  response: ResponseFrame,
): Effect.Effect<ResultOf<D>, FrameSchemaError> {
  if (!("result" in response)) {
    return Effect.fail(
      new FrameSchemaError({
        direction: "inbound",
        expected: "response",
        raw: encodeFrame(response),
        reason: "expected response frame for rpc reply",
      }),
    );
  }
  return decodeRpcResult(definition, response.result).pipe(
    Effect.mapError(() =>
      inboundFrameSchemaError(
        encodeFrame(response),
        `invalid result for rpc method ${definition.name}`,
      ),
    ),
  );
}

function sendMalformedFrame<D extends AnyRpcDefinition>(
  runtime: TestClientRuntime,
  opts: Parameters<TestClient["sendMalformed"]>[0] & {
    readonly baseDefinition: D;
    readonly baseParams: ParamsOf<D>;
  },
): Effect.Effect<
  RpcResponseError | null,
  TransportClosedError | TransportIoError | FrameSchemaError
> {
  return Effect.gen(function* () {
    const baseFrame = requestFrame(
      nextRequestId(),
      opts.baseDefinition,
      opts.baseParams,
    );
    const raw = malformFrame(baseFrame, opts.kind, opts.seed);
    const deferred = yield* Deferred.make<
      ResponseFrame,
      RpcResponseError | TransportClosedError
    >();
    runtime.pending.set(baseFrame.id, deferred);
    yield* recordMalformed(runtime.captures, raw, opts.kind);
    yield* writeFrame(runtime, raw);
    return yield* waitForMalformedOutcome(runtime, deferred, baseFrame.id);
  });
}

function waitForMalformedOutcome(
  runtime: TestClientRuntime,
  deferred: Deferred.Deferred<
    ResponseFrame,
    RpcResponseError | TransportClosedError
  >,
  id: JsonRpcId,
): Effect.Effect<RpcResponseError | null, TransportClosedError> {
  const waitMs =
    runtime.config.malformedQuiescenceMs ?? DEFAULT_MALFORMED_QUIESCENCE_MS;
  return Effect.raceFirst(
    awaitMalformedResponse(deferred),
    Effect.succeed<RpcResponseError | null>(null).pipe(
      Effect.delay(Duration.millis(waitMs)),
    ),
  ).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        runtime.pending.delete(id);
      }),
    ),
  );
}

function awaitMalformedResponse(
  deferred: Deferred.Deferred<
    ResponseFrame,
    RpcResponseError | TransportClosedError
  >,
): Effect.Effect<RpcResponseError | null, TransportClosedError> {
  return Deferred.await(deferred).pipe(
    Effect.matchEffect({
      onSuccess: () => Effect.succeed<RpcResponseError | null>(null),
      onFailure: (err) =>
        err instanceof RpcResponseError
          ? Effect.succeed<RpcResponseError | null>(err)
          : Effect.fail(err),
    }),
  );
}

function takeNotification<D extends AnyNotificationDefinition>(
  runtime: TestClientRuntime,
  definition: D,
): Effect.Effect<DecodedNotification<D> | null> {
  return Ref.modify(runtime.notificationQueue, (notifications) => {
    for (const [idx, notification] of notifications.entries()) {
      if (!isDecodedNotification(definition, notification)) continue;
      return [
        notification,
        [...notifications.slice(0, idx), ...notifications.slice(idx + 1)],
      ];
    }
    return [null, notifications];
  });
}

function waitForNotification<D extends AnyNotificationDefinition>(
  runtime: TestClientRuntime,
  definition: D,
  timeoutMs = DEFAULT_WAIT_FOR_NOTIFICATION_TIMEOUT_MS,
): Effect.Effect<DecodedNotification<D>, NotificationWaitError> {
  return pollNotification(runtime, definition).pipe(
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
}

function pollNotification<D extends AnyNotificationDefinition>(
  runtime: TestClientRuntime,
  definition: D,
): Effect.Effect<DecodedNotification<D>, NotificationWaitError> {
  return Effect.gen(function* () {
    while (true) {
      const notification = yield* takeNotification(runtime, definition);
      if (notification !== null) return notification;
      yield* failIfClosedWhileWaiting(runtime, definition);
      yield* Effect.sleep(Duration.millis(POLL_INTERVAL_MS));
    }
  });
}

function failIfClosedWhileWaiting(
  runtime: TestClientRuntime,
  definition: AnyNotificationDefinition,
): Effect.Effect<void, NotificationWaitError> {
  return Effect.gen(function* () {
    const state = yield* Ref.get(runtime.closeRef);
    if (!state.closed) return;
    return yield* Effect.fail(
      new NotificationWaitError({
        definition,
        message: `Connection closed while waiting for notification: ${definition.name}`,
        reason: "closed",
      }),
    );
  });
}

function makeNotificationsStream(
  runtime: TestClientRuntime,
): Stream.Stream<
  DecodedNotification<AnyNotificationDefinition>,
  TransportClosedError
> {
  return Stream.repeatEffectChunk(
    pullNotifications(runtime).pipe(Effect.map(Chunk.fromIterable)),
  );
}

function pullNotifications(
  runtime: TestClientRuntime,
): Effect.Effect<
  ReadonlyArray<DecodedNotification<AnyNotificationDefinition>>,
  TransportClosedError
> {
  return Effect.gen(function* () {
    while (true) {
      const state = yield* Ref.get(runtime.closeRef);
      if (state.closed) return yield* Effect.fail(socketClosedError(state));
      const queue = yield* Ref.getAndSet(runtime.notificationQueue, []);
      if (queue.length > 0) return queue;
      yield* Effect.sleep(Duration.millis(POLL_INTERVAL_MS));
    }
  });
}

function socketClosedError(state: CloseState): TransportClosedError {
  return new TransportClosedError({
    direction: "inbound",
    code: state.code,
    reason: state.reason,
  });
}

function registerServerRpcHandler(
  runtime: TestClientRuntime,
  definition: ServerRpcDefinition,
  handler: AppCallbackHandler,
): Effect.Effect<void> {
  return Ref.update(runtime.appCallbackHandlersRef, (handlers) =>
    HashMap.set(handlers, definition, handler),
  );
}

function awaitServerRequest<D extends ServerRpcDefinition>(
  runtime: TestClientRuntime,
  input: AwaitServerRequestInput<D>,
): Effect.Effect<ServerRpcParams<D>, ServerRequestWaitError> {
  return Effect.gen(function* () {
    const entry = yield* makeAwaitEntry(input);
    yield* addAwaitEntry(runtime, input.definition, entry);
    const result = yield* awaitEntryResult(runtime, input.definition, entry, {
      timeoutMs: input.timeoutMs,
    });
    return result as ServerRpcParams<D>;
  });
}

function makeAwaitEntry<D extends ServerRpcDefinition>(
  input: AwaitServerRequestInput<D>,
): Effect.Effect<AwaitEntry> {
  return Effect.gen(function* () {
    const deferred = yield* Deferred.make<unknown, ServerRequestWaitError>();
    const predicate = input.predicate;
    if (predicate === undefined) return { deferred };
    return {
      deferred,
      predicate: (params: unknown) => predicate(params as ServerRpcParams<D>),
    };
  });
}

function addAwaitEntry(
  runtime: TestClientRuntime,
  definition: ServerRpcDefinition,
  entry: AwaitEntry,
): Effect.Effect<void> {
  return Ref.update(runtime.awaitersRef, (awaiters) =>
    appendAwaitEntry(awaiters, definition, entry),
  );
}

function appendAwaitEntry(
  awaiters: AwaitersMap,
  definition: ServerRpcDefinition,
  entry: AwaitEntry,
): AwaitersMap {
  const bucket = HashMap.get(awaiters, definition);
  const next: ReadonlyArray<AwaitEntry> =
    bucket._tag === "Some" ? [...bucket.value, entry] : [entry];
  return HashMap.set(awaiters, definition, next);
}

function awaitEntryResult(
  runtime: TestClientRuntime,
  definition: ServerRpcDefinition,
  entry: AwaitEntry,
  options: { readonly timeoutMs: number },
): Effect.Effect<unknown, ServerRequestWaitError> {
  return Deferred.await(entry.deferred).pipe(
    Effect.timeoutFail({
      duration: Duration.millis(options.timeoutMs),
      onTimeout: () =>
        new ServerRequestWaitError({
          message: `Timeout waiting for server-initiated request ${definition.name}`,
          definition,
          reason: "timeout",
        }),
    }),
    Effect.onExit((exit) =>
      removeAwaitEntryOnFailure(exit, runtime.awaitersRef, definition, entry),
    ),
  );
}

function autoConnect(
  runtime: TestClientRuntime,
): Effect.Effect<void, TransportClosedError | TransportIoError> {
  const handshakeParams: ParamsOf<typeof Connect> = {
    agentKey: runtime.config.agentKey,
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
  };
  return sendClientRpc(runtime, {
    definition: Connect,
    params: handshakeParams,
  }).pipe(
    Effect.catchTag("TestingRpcTimeoutError", () => Effect.void),
    Effect.catchTag("TestingFrameSchemaError", () => Effect.void),
    Effect.catchTag("TestingRpcResponseError", () => Effect.void),
  );
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
  return openTestClientRuntime(config).pipe(
    Effect.map((runtime) => new RuntimeTestClient(runtime)),
    Effect.withSpan("makeTestClient"),
  );
}

export function makeCloseableTestClient(
  config: TestClientConfig,
): Effect.Effect<
  CloseableTestClient,
  TransportIoError | TransportClosedError | RpcResponseError
> {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    const runtime = yield* Scope.extend(openTestClientRuntime(config), scope);
    return new RuntimeTestClient(
      runtime,
      Scope.close(scope, Exit.void),
    ) as CloseableTestClient;
  }).pipe(Effect.withSpan("makeCloseableTestClient"));
}
