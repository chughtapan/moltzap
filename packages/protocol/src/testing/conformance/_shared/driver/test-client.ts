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
  Schema,
} from "effect";
import * as Socket from "@effect/platform/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import type {
  AnyAppCallbackRpcDefinition,
  AnyServerRpcDefinition,
} from "../../../../rpc-registry.js";
import { appCallbackMethods } from "../../../../rpc-registry.js";
import type {
  NotificationParamsOf,
  ParamsOf,
  ResultOf,
  DecodedNotification,
  DecodedRpcRequest,
  NotificationFrame,
  RequestFrame,
  ResponseFrame,
  JsonRpcId,
} from "../../../../transport/index.js";
import {
  requestFrame,
  responseFrame,
  decodeRpcResult,
  decodeNotification,
  decodeRpcRequest,
} from "../../../index.js";
import type { AnyNotificationDefinition } from "../../../../rpc-registry.js";
import { notificationDefinitions } from "../../../../rpc-registry.js";
import { AgentId } from "../../../../identity/index.js";
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
import {
  makeTestSubscriberRegistry,
  subscribe as registrySubscribe,
  subscribeAll as registrySubscribeAll,
  type TestSubscriberRegistry,
} from "./test-subscribers.js";

import { Connect } from "../../../../network/index.js";

/**
 * Options for connecting a TestClient. `serverUrl` is the `ws://…` URL of
 * the real server; `agentKey` + `agentId` are for the `connect` handshake.
 * `defaultTimeoutMs` bounds each `sendRpc` unless overridden per call.
 */
export interface TestClientConfig {
  readonly serverUrl: string;
  readonly agentKey: string;
  readonly agentId: Schema.Schema.Type<typeof AgentId>;
  readonly defaultTimeoutMs: number;
  /** Soft cap on captured frames before the ring buffer drops oldest. */
  readonly captureCapacity: number;

  /**
   * D #705 CP5/CP7 — when set, the `network/connect` handshake uses the
   * app-principal `appKey` arm instead of the agent `agentKey` arm, so the
   * connection authenticates as an `AppConnection`. Used by app-arm
   * integration tests (e.g. `app-session-scoping`) that drive the moderator app
   * as a first-class app principal rather than the dead #673 agent-AppsRegisters
   * model. Mutually exclusive with the agent path at the wire (the Connect
   * params union is disjoint).
   */
  readonly appKey?: string;

  /**
   * When `true`, send the `network/connect` handshake automatically after the
   * WS upgrade. Defaults to `true`.
   */
  readonly autoConnect?: boolean;
  /** Quiescence window (ms) for `sendMalformed` to wait for a response. */
  readonly malformedQuiescenceMs?: number;
}

/** Error channel shared by every `sendRpc` surface (interface + impls). */
type SendRpcError =
  | RpcResponseError
  | RpcTimeoutError
  | TransportClosedError
  | TransportIoError
  | FrameSchemaError;

/**
 * Handle surface. Scoped: acquiring the handle opens the WS; releasing the
 * scope closes it. All methods return Effects so property code can compose
 * them inside `Effect.forEach` / `fc.asyncProperty`.
 */
export interface TestClient {
  readonly sendRpc: <D extends AnyServerRpcDefinition>(
    definition: D,
    params: ParamsOf<D>,
    opts?: { readonly timeoutMs?: number },
  ) => Effect.Effect<ResultOf<D>, SendRpcError>;

  readonly sendMalformed: <D extends AnyServerRpcDefinition>(opts: {
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

  readonly captures: CaptureBuffer;
  readonly snapshot: Effect.Effect<ReadonlyArray<CapturedFrame>>;

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
   * Register a handler for an app-callback RPC (test-driver-local;
   * distinct from the production `MoltZapAgentClient`'s static handler
   * table, which is immutable per Spec F I1).
   *
   * When `handleInbound` sees a request frame whose method matches,
   * the handler runs and its outcome is encoded as the JSON-RPC
   * response:
   *   - `Effect.succeed(value)` → `{ result: value }`
   *   - `Effect.fail(err: RpcResponseError)` → `{ error: { _tag, message?, data? } }`
   *   - defects collapse to a generic `InternalError` reply so the
   *     server's `Deferred.await` cannot hang on a crashing handler.
   *
   * Re-registration replaces the prior handler (later wins) — mirrors
   * `HashMap.set`. The TestClient does NOT raise on duplicates; tests
   * routinely swap behaviour mid-scenario. This is the deliberate
   * driver-side relaxation that lets conformance tests exercise
   * scenarios the static production table cannot express.
   *
   * `M` constrains to the registered app-callback method names and
   * `params`/`result` bind to the matching descriptor.
   */
  readonly onAppCallback: <D extends ServerRpcDefinition>(
    definition: D,
    handler: (
      params: ServerRpcParams<D>,
      ctx: ServerRpcContext,
    ) => Effect.Effect<ServerRpcResult<D>, RpcResponseError>,
  ) => Effect.Effect<void>;

  /**
   * Park until the server sends an app-callback request for `method`. The handler
   * registered via {@link onAppCallback} (if any) still runs and replies;
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
export type ServerRpcDefinition = AnyAppCallbackRpcDefinition;

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
  readonly subscribers: TestSubscriberRegistry;
  readonly onAppCallbackHandlersRef: Ref.Ref<
    HashMap.HashMap<ServerRpcDefinition, AppCallbackHandler>
  >;
  readonly awaitersRef: Ref.Ref<AwaitersMap>;
  readonly socket: Socket.Socket;
  readonly writer: SocketWriter;
}

let requestIdCounter = 0;

const DEFAULT_AWAIT_SERVER_REQUEST_TIMEOUT_MS = 5_000;
const DEFAULT_MALFORMED_QUIESCENCE_MS = 500;
const HANDLER_DEFECT_MESSAGE_LIMIT = 200;

// The native engine parses the wire request id with `BigInt(id)`
// (`@effect/rpc/RpcMessage → RequestId`) and the JSON-RPC serialization
// round-trips it through `Number(id)`, so the driver's id must be a numeric
// value within `Number.MAX_SAFE_INTEGER` — beyond it, distinct ids collapse to
// the same `Number`, misrouting concurrent responses to the wrong pending call.
// A process-start epoch base (no sub-millisecond multiplier) plus the monotonic
// `requestIdCounter` keeps ids unique across every client on one socket while
// staying safe-integer for the lifetime of a test run.
const REQUEST_ID_BASE = Date.now();

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
  return String(REQUEST_ID_BASE + requestIdCounter);
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

interface SendRpcInput<D extends AnyServerRpcDefinition> {
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

  constructor(
    private readonly runtime: TestClientRuntime,
    close?: Effect.Effect<void, never>,
  ) {
    if (close !== undefined) {
      this.close = close;
    }
    this.captures = runtime.captures;
    this.snapshot = runtime.captures.snapshot;
  }

  sendRpc<D extends AnyServerRpcDefinition>(
    definition: D,
    params: ParamsOf<D>,
    opts?: { readonly timeoutMs?: number },
  ): Effect.Effect<ResultOf<D>, SendRpcError> {
    const input: SendRpcInput<D> =
      opts === undefined
        ? { definition, params }
        : { definition, params, opts };
    return sendClientRpc(this.runtime, input);
  }

  sendMalformed<D extends AnyServerRpcDefinition>(
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
    return writeOutboundFrame(this.runtime, frame, "s2c");
  }

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
    definition: D,
    // eslint-disable-next-line agent-code-guard/no-conditional-chaining -- optional refinement is a value-level passthrough to the Stream factory; not a refinement-of-discriminant decision
    refinement?: (params: NotificationParamsOf<D>) => boolean,
  ): Stream.Stream<DecodedNotification<D>, TransportClosedError> {
    return registrySubscribe(this.runtime.subscribers, definition, refinement);
  }

  subscribeAll(
    // eslint-disable-next-line agent-code-guard/no-conditional-chaining -- optional refinement is a value-level passthrough to the Stream factory; not a refinement-of-discriminant decision
    refinement?: (
      notification: DecodedNotification<AnyNotificationDefinition>,
    ) => boolean,
  ): Stream.Stream<
    DecodedNotification<AnyNotificationDefinition>,
    TransportClosedError
  > {
    return registrySubscribeAll(this.runtime.subscribers, refinement);
  }

  onAppCallback<D extends ServerRpcDefinition>(
    definition: D,
    handler: (
      params: ServerRpcParams<D>,
      ctx: ServerRpcContext,
    ) => Effect.Effect<ServerRpcResult<D>, RpcResponseError>,
  ): Effect.Effect<void> {
    return registerAppCallbackHandler(
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
      subscribers: yield* makeTestSubscriberRegistry(),
      onAppCallbackHandlersRef: yield* Ref.make(
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
    // Plan §R3: register `subscribers.closeAll` AFTER the socket reader
    // fork. Scope finalizers fire LIFO, so this `closeAll` runs BEFORE
    // the socket reader's `forkScoped` interruption finalizer — every
    // in-flight `Stream.async` consumer sees a typed
    // `TransportClosedError` via `emit.fail` before the transport tears
    // down. Mirrors production's `composeServiceTeardown` ordering
    // between `MoltZapService.scope` and `MoltZapAgentClient.close()`.
    yield* Effect.addFinalizer(() => runtime.subscribers.closeAll);
    if (config.autoConnect !== false) {
      yield* autoConnect(runtime);
    }
    return runtime;
  });
}

function writeFrame(
  runtime: TestClientRuntime,
  raw: string,
  channel: "c2s" | "s2c",
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
    // The live server multiplexes the socket with a `{ ch, f }` envelope
    // (`mux.ts`). A fresh request goes on the `c2s` (client→server)
    // endpoint; a REPLY to a server-originated callback goes back on `s2c` — the
    // channel that callback request arrived on — so the s2c engine correlates it.
    const enveloped = JSON.stringify({ ch: channel, f: raw });
    yield* runtime
      .writer(enveloped)
      .pipe(Effect.mapError(outboundTransportIoError));
  });
}

function writeReply(
  runtime: TestClientRuntime,
  reply: ResponseFrame,
): Effect.Effect<void> {
  return writeOutboundFrame(runtime, reply, "s2c").pipe(Effect.ignore);
}

function writeOutboundFrame(
  runtime: TestClientRuntime,
  frame: AnyFrame,
  channel: "c2s" | "s2c",
): Effect.Effect<void, TransportClosedError | TransportIoError> {
  const raw = encodeFrame(frame);
  return recordFrame(runtime.captures, "outbound", raw, frame).pipe(
    Effect.zipRight(writeFrame(runtime, raw, channel)),
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
          tag: frame.error._tag,
          message: frame.error.message ?? "",
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
  // The server fires notifications as void-result s2c RPCs and parks until the
  // client acks. Fan the frame out to subscribers + awaiters, then reply with
  // the void ack so the server-side round-trip unblocks.
  if (NOTIFICATION_METHODS.has(frame.method)) {
    return handleNotificationRequestFrame(runtime, frame);
  }
  return decodeRpcRequest(appCallbackMethods, frame).pipe(
    Effect.matchEffect({
      onFailure: () => writeReply(runtime, invalidCallbackRequestReply(frame)),
      onSuccess: (request) => handleDecodedServerRequest(runtime, request),
    }),
  );
}

function handleNotificationRequestFrame(
  runtime: TestClientRuntime,
  frame: RequestFrame,
): Effect.Effect<void> {
  return decodeNotification(notificationDefinitions, asNotificationFrame(frame))
    .pipe(
      Effect.matchEffect({
        onFailure: () => Effect.void,
        onSuccess: (notification) => runtime.subscribers.dispatch(notification),
      }),
    )
    .pipe(
      Effect.zipRight(
        writeReply(runtime, responseFrame(frame.id, { result: {} })),
      ),
    );
}

/** Re-shape a notification carried as an s2c request into a notification frame. */
function asNotificationFrame(frame: RequestFrame): NotificationFrame {
  return {
    jsonrpc: "2.0",
    method: frame.method,
    ...(frame.params !== undefined ? { params: frame.params } : {}),
  };
}

function invalidCallbackRequestReply(frame: RequestFrame): ResponseFrame {
  return responseFrame(frame.id, {
    error: {
      _tag: "InvalidParamsError",
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
      onSuccess: (notification) => runtime.subscribers.dispatch(notification),
    }),
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
    const handlers = yield* Ref.get(runtime.onAppCallbackHandlersRef);
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
      _tag: "NotFound",
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
            _tag: err.tag,
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
      _tag: "InternalError",
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

/**
 * The channel-mux envelope every wire chunk rides in (`mux.ts`). The
 * driver decodes `f` — the JSON-RPC frame — and ignores `ch` (it serves the
 * single c2s endpoint plus the s2c reverse frames the server pushes).
 */
const MuxEnvelopeSchema = Schema.Struct({
  ch: Schema.Literal("c2s", "s2c"),
  f: Schema.String,
});
const decodeMuxEnvelope = Schema.decodeUnknownEither(MuxEnvelopeSchema);

// The wire-method names the server fires as NOTIFICATIONS. The server stands
// these on the s2c reverse `RpcClient` as void-result RPCs (`originator.notify`)
// and AWAITS the client's void ack — a server-side round-trip stays parked until
// the reply lands. So the driver keeps the `id` on a known-notification frame
// (it is a genuine s2c request) and `handleRequestFrame` both fans it out to
// subscribers and replies with the void ack, mirroring the production client's
// engine auto-reply. Dropping the `id` here would strand every server round-trip
// that fires a notification (e.g. the dispatch deny-removal sequence).
const NOTIFICATION_METHODS = new Set<string>(
  notificationDefinitions.map((d) => d.name as string),
);

function decodeSocketData(data: string | Uint8Array): string {
  const text =
    typeof data === "string" ? data : new TextDecoder("utf-8").decode(data);
  // Unwrap the `{ ch, f }` mux envelope to the JSON-RPC frame. A chunk that is
  // not an envelope (a bare frame from a non-mux peer) passes through unchanged.
  const frame = Either.match(decodeMuxEnvelope(safeJsonParse(text)), {
    onLeft: () => text,
    onRight: (env) => env.f,
  });
  return normalizeNativeFrame(frame);
}

/**
 * Reconcile a native `@effect/rpc`/jsonRpc wire frame with the driver's strict
 * JSON-RPC frame schema:
 *   - strip the native-engine extras (`headers`, `traceId`, `spanId`,
 *     `sampled`) the strict schema rejects as excess keys;
 *   - re-stringify a numeric top-level `id` (the driver brands a STRING id).
 * A server-pushed notification keeps its `id`: the server awaits a void ack, so
 * the frame stays a request and `handleRequestFrame` both fans it out and acks.
 * A payload the bridge does not recognize passes through unchanged.
 */
function normalizeNativeFrame(frame: string): string {
  const parsed = safeJsonParse(frame);
  if (typeof parsed !== "object" || parsed === null) return frame;
  return Either.match(decodeNativeFrame(parsed), {
    onLeft: () => frame,
    onRight: ({ id, method, rest }) => {
      const flat =
        "error" in rest
          ? { ...rest, error: unwrapCauseError(rest["error"]) }
          : rest;
      return JSON.stringify({
        ...flat,
        ...(method !== undefined ? { method } : {}),
        ...(id !== undefined ? { id: String(id) } : {}),
      });
    },
  });
}

/**
 * Flatten the `jsonRpc` error envelope to the driver's `{ _tag, message?, data?
 * }` wire error. The serialization wraps an Exit failure as
 * `{ _tag: "Cause", data: { _tag: "Fail", error: <taggedError> } }` (a typed
 * failure) or `{ _tag: "Defect", … }` (a die). A `Fail` cause unwraps to its
 * inner tagged error; anything else collapses to a generic internal error.
 */
/** A value carrying a string `_tag` — the shape a flattened tagged error has. */
const taggedError = (
  value: unknown,
): Option.Option<{ readonly _tag: string }> =>
  Option.fromNullable(value).pipe(
    Option.filter(
      (v): v is { readonly _tag: string } =>
        typeof v === "object" &&
        typeof (v as { readonly _tag?: unknown })._tag === "string",
    ),
  );

function unwrapCauseError(error: unknown): unknown {
  const envelope = taggedError(error);
  if (Option.isNone(envelope)) return error;
  const e = envelope.value;
  if (e._tag !== "Cause" && e._tag !== "Defect") return error;
  const cause = taggedError((e as { readonly data?: unknown }).data);
  const inner = Option.flatMap(cause, (c) =>
    c._tag === "Fail"
      ? taggedError((c as { readonly error?: unknown }).error)
      : Option.none(),
  );
  if (Option.isSome(inner)) return inner.value;
  const message = (e as { readonly message?: unknown }).message;
  // eslint-disable-next-line agent-code-guard/manual-tagged-error -- this builds the WIRE `{ _tag, message }` error payload the driver re-serializes into a response frame (read at `frame.error._tag`), not an Effect error to raise; `Data.TaggedError` would change the serialized shape.
  return {
    _tag: "InternalError",
    message: typeof message === "string" ? message : "server defect",
  };
}

// Picks the native extras off a frame and exposes `id`/`method` for the
// notification demotion; `rest` keeps the JSON-RPC keys (`jsonrpc`, `params`,
// `result`, `error`) verbatim. A non-object frame fails the decode and the
// caller returns the frame unchanged.
const NativeFrameSchema = Schema.Struct(
  {
    id: Schema.optional(Schema.Union(Schema.Number, Schema.String)),
    method: Schema.optional(Schema.String),
    headers: Schema.optional(Schema.Unknown),
    traceId: Schema.optional(Schema.Unknown),
    spanId: Schema.optional(Schema.Unknown),
    sampled: Schema.optional(Schema.Unknown),
  },
  { key: Schema.String, value: Schema.Unknown },
).pipe(
  Schema.transform(
    Schema.Struct({
      id: Schema.optional(Schema.Union(Schema.Number, Schema.String)),
      method: Schema.optional(Schema.String),
      rest: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
    }),
    {
      // The source struct's index signature folds `headers`/`traceId`/`spanId`/
      // `sampled` into the indexed rest; drop them so only the JSON-RPC keys
      // (`jsonrpc`, `params`, `result`, `error`) survive into `rest`.
      decode: ({ id, method, ...indexed }) => {
        const rest: Record<string, unknown> = { ...indexed };
        for (const key of ["headers", "traceId", "spanId", "sampled"]) {
          delete rest[key];
        }
        return { id, method, rest };
      },
      encode: ({ id, method, rest }) => ({ id, method, ...rest }),
    },
  ),
);
const decodeNativeFrame = Schema.decodeUnknownEither(NativeFrameSchema);

/**
 * Parse JSON, returning `null` on failure (callers fail over to the raw text). A
 * non-JSON socket chunk is an expected wire condition here, not an error to log,
 * so the parse failure is folded to `null` via `Either`.
 */
function safeJsonParse(text: string): unknown {
  return Either.getOrNull(Either.try(() => JSON.parse(text) as unknown));
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

function sendClientRpc<D extends AnyServerRpcDefinition>(
  runtime: TestClientRuntime,
  input: SendRpcInput<D>,
): Effect.Effect<ResultOf<D>, SendRpcError> {
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
    yield* writeFrame(runtime, raw, "c2s");
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

function decodeRpcSuccessResult<D extends AnyServerRpcDefinition>(
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
    // `decodeRpcResult` over the opaque `D extends AnyServerRpcDefinition`
    // infers the result as the abstract `Schema.Schema.Type<R>`; widen to
    // `ResultOf<D>` (the same type, named through the descriptor) so the
    // `TestClient.sendRpc` signature's `Effect<ResultOf<D>, …>` is satisfied.
    Effect.map((result) => result as ResultOf<D>),
    Effect.mapError(() =>
      inboundFrameSchemaError(
        encodeFrame(response),
        `invalid result for rpc method ${definition.name}`,
      ),
    ),
  );
}

function sendMalformedFrame<D extends AnyServerRpcDefinition>(
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
    yield* writeFrame(runtime, raw, "c2s");
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

function registerAppCallbackHandler(
  runtime: TestClientRuntime,
  definition: ServerRpcDefinition,
  handler: AppCallbackHandler,
): Effect.Effect<void> {
  return Ref.update(runtime.onAppCallbackHandlersRef, (handlers) =>
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
  // The single `credential` carries the principal prefix: a configured app
  // credential authenticates as an `AppConnection`, otherwise the agent
  // credential runs. The server prefix-resolves `moltzap_app_` /
  // `moltzap_agent_`.
  const handshakeParams: ParamsOf<typeof Connect> = {
    credential: runtime.config.appKey ?? runtime.config.agentKey,
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
