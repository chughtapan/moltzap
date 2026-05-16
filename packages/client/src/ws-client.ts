import * as Socket from "@effect/platform/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  Data,
  Deferred,
  Duration,
  Either,
  Effect,
  Exit,
  Fiber,
  HashMap,
  ManagedRuntime,
  Option,
  Queue,
  Ref,
  Schedule,
  Scope,
} from "effect";
import {
  PROTOCOL_VERSION,
  Connect,
  encodeErrorResponse,
  makeJsonRpcClient,
  makeJsonRpcServer,
  NotConnectedError,
  RpcServerError,
  RpcTimeoutError,
  type AnyTaskCallbackRpcDefinition,
  type AnyNotificationDefinition,
  type DecodedNotification,
  type DecodedServerInbound,
  type JsonRpcClient,
  type JsonRpcId,
  type ParamsOf,
  type ResponseFrame,
  type ResultOf,
  type RpcCallError,
  type RpcDefinition,
  type RpcHandler,
} from "@moltzap/protocol";
import { DuplicateServerRpcHandlerError } from "./runtime/errors.js";
import { decodeFrames } from "./runtime/frame.js";
import {
  makeSubscriberRegistry,
  type NotificationSubscription,
  type SubscriberHandler,
  type SubscriberRegistry,
  type SubscriptionFilter,
} from "./runtime/subscribers.js";
import { extractCloseInfo, type CloseInfo } from "./runtime/close-info.js";

// Re-export `CloseInfo` so consumers can import it from
// `@moltzap/client` alongside `MoltZapWsClient` itself; the type lives
// in `runtime/close-info.ts` for build hygiene but the public surface
// is the package barrel and direct `ws-client.ts` import path.
export type { CloseInfo };

/**
 * Default per-RPC timeout. Exported so tests driving `TestClock` can match
 * exactly — keeps tests from silently drifting if this changes.
 */
export const RPC_TIMEOUT_MS = 30_000;

export interface RpcCallOptions {
  readonly timeoutMs?: number;
}

type ConnectError = RpcCallError | RpcTimeoutError;

/** Reconnect backoff: 1s base, doubling per attempt up to the cap. */
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RECONNECT_BACKOFF_FACTOR = 2;
const NORMAL_CLOSE_CODE = 1000;
const EVENT_WAIT_TIMEOUT_MS = 5000;
const WEB_SOCKET_OPEN_TIMEOUT_SECONDS = 10;
const MALFORMED_FRAME_PREVIEW_CHARS = 200;

/**
 * Log 1-of-N malformed frames. A misbehaving server could flood us otherwise;
 * the counter in the log makes it clear how many we've dropped between logs.
 */
const MALFORMED_LOG_EVERY = 50;

/**
 * Cap on the per-client notification buffer. Any frame that has no live
 * `waitForNotification` awaiter lands here until someone drains it. Excess
 * frames are evicted FIFO so a slow consumer can't leak memory.
 */
const MAX_EVENT_BUFFER = 1000;

/**
 * Capacity of the per-connection task-callback executor queue. Sized at
 * 8192 to preserve the pre-cutover burst envelope (256 partitions × 32
 * per-partition queue depth = 8192). Sized once at queue construction;
 * the queue is bounded so the WS reader exerts back-pressure on a slow
 * handler instead of leaking memory.
 *
 * Per architect plan #533 §"Revisions r1 correction 3": this matches
 * today's burst envelope under the partition-replaced single-drain
 * topology.
 */
const TASK_CALLBACK_QUEUE_CAPACITY = 8192;

const MSG_NOT_CONNECTED = "WebSocket not connected";

const UTF8_DECODER = new TextDecoder("utf-8");

const makeNotConnectedError = (): NotConnectedError =>
  new NotConnectedError({ message: MSG_NOT_CONNECTED });

type ConnectResult = ResultOf<typeof Connect>;
type DecodedIncomingFrame = Effect.Effect.Success<
  ReturnType<typeof decodeFrames>
>[number];
type DecodedIncomingResponse = Extract<
  DecodedIncomingFrame,
  { readonly _tag: "ResponseSuccess" | "ResponseError" }
>;
type DecodedIncomingNotification = Extract<
  DecodedIncomingFrame,
  { readonly _tag: "Notification" }
>;

class ReconnectAttemptFailedError extends Data.TaggedError(
  "ReconnectAttemptFailedError",
)<{
  readonly reason: string;
}> {}

/**
 * Per-connection runtime state. `None` = not connected → `sendRpc` fails fast
 * with `NotConnectedError`.
 *
 * Cutover (#533): the partitioned dispatcher is replaced by a single
 * bounded global queue + single drain fiber. The queue holds decoded
 * server-initiated requests; the drain fiber runs handlers serially.
 * Capacity = `TASK_CALLBACK_QUEUE_CAPACITY` (8192, preserves the
 * pre-cutover 256×32 burst envelope). Held here alongside its own
 * `dispatcherScope` (NOT bound to the socket scope) so
 * `runSync(client.close())` can `runFork(Scope.close(…))` without
 * yielding through the runtime — the load-bearing regression gate at
 * `ws-client.test.ts:1233-1259`.
 */
interface ConnState {
  readonly write: (
    chunk: string | Socket.CloseEvent,
  ) => Effect.Effect<void, Socket.SocketError>;
  readonly readerFiber: Fiber.RuntimeFiber<void, Socket.SocketError>;
  readonly scope: Scope.CloseableScope;
  readonly jsonRpcClient: JsonRpcClient;

  /**
   * Settled when the reader fiber exits, letting `connect()` race against
   * pre-open close and fail fast instead of waiting the RPC timeout.
   */
  readonly handshakeSettled: Deferred.Deferred<ConnectResult, ConnectError>;

  /**
   * Per-connection task-callback executor queue. Bounded; the WS reader
   * non-blockingly offers decoded requests, the drain fiber runs
   * handlers one at a time. Replaces the pre-cutover partitioned
   * dispatcher with the simpler single-queue topology.
   */
  readonly taskCallbackQueue: Queue.Queue<DecodedServerRequest>;

  /**
   * Closeable Scope owning the drain fiber. Off-Scope from the socket
   * so `runSync(client.close())` can `runFork(Scope.close(...))`
   * without yielding.
   */
  readonly dispatcherScope: Scope.CloseableScope;
}

type DecodedServerRequest = Extract<
  DecodedServerInbound,
  { readonly _tag: "ServerRequest" }
>;

type ClientWebSocket = Effect.Effect.Success<
  ReturnType<typeof Socket.makeWebSocket>
>;

interface TaskCallbackDispatcher {
  readonly dispatcherScope: Scope.CloseableScope;
  readonly taskCallbackQueue: Queue.Queue<DecodedServerRequest>;
}

/**
 * Handler signature for `handleServerRpc`. The handler returns an
 * `Effect&lt;unknown, RpcServerError>` — success values are encoded as the
 * response `result`; typed RPC errors are encoded as the response
 * `error`. Defects (handler crashes, non-tagged exceptions) collapse to a
 * generic InternalError reply.
 *
 * The `unknown`/`unknown` parameter and result types narrow generically
 * against `taskCallbackMethods` at each `handleServerRpc(definition,
 * handler)` call site via the `AnyTaskCallbackRpcDefinition` union. Phase
 * 9b consumer-migration retired the legacy `AppCallbackRpcMap` indirection
 * alongside the appCallback group collapse to a single member.
 */
export interface ServerRpcContext {
  readonly requestId: JsonRpcId;
  readonly definition: AnyTaskCallbackRpcDefinition;
  readonly traceparent?: string;
}

export type ServerRpcHandler<
  D extends AnyTaskCallbackRpcDefinition = AnyTaskCallbackRpcDefinition,
> = (
  params: ParamsOf<D>,
  ctx: ServerRpcContext & { readonly definition: D },
) => Effect.Effect<ResultOf<D>, RpcServerError>;

type ErasedServerRpcHandler = (
  params: unknown,
  ctx: ServerRpcContext,
) => Effect.Effect<unknown, RpcServerError>;

interface NotificationWaiter {
  readonly definition: AnyNotificationDefinition;
  readonly complete: (
    notification: DecodedNotification<AnyNotificationDefinition>,
  ) => Effect.Effect<void>;
  readonly fail: (error: Error) => Effect.Effect<void>;
}

/**
 * Notifications are pre-validated by the wire decoder
 * (`decodeNotification` in `@moltzap/protocol`) — fail-close on unknown
 * methods or bad params. Buffer + waiters hold the validated shape
 * directly; no separate Raw|Unknown lift remains.
 */

function acceptTypedNotification<D extends AnyNotificationDefinition>(
  definition: D,
  notification: DecodedNotification<AnyNotificationDefinition>,
): notification is DecodedNotification<D> {
  return notification.definition === definition;
}

/** Drop `waiter` from its notification-definition bucket, pruning an empty bucket. */
function removeWaiter(
  m: HashMap.HashMap<
    AnyNotificationDefinition,
    ReadonlyArray<NotificationWaiter>
  >,
  definition: AnyNotificationDefinition,
  waiter: NotificationWaiter,
): HashMap.HashMap<
  AnyNotificationDefinition,
  ReadonlyArray<NotificationWaiter>
> {
  const bucket = HashMap.get(m, definition);
  if (bucket._tag === "None") return m;
  const filtered = bucket.value.filter((w) => w !== waiter);
  return filtered.length === 0
    ? HashMap.remove(m, definition)
    : HashMap.set(m, definition, filtered);
}

export interface WsClientLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface MoltZapWsClientOptions {
  serverUrl: string;
  agentKey: string;

  /**
   * Called once per disconnect (not reconnect). Spec #222 §5.4 + OQ-5 (A):
   * `close` is the typed close metadata — real WebSocket `{code, reason}`
   * when the transport surfaces them, OQ-5 defaults otherwise. Required
   * arg (OQ-6 rewrite): zero-arg `() => void` callers must migrate to
   * accept (and may ignore) the arg.
   *
   * Migration note (spec #222 OQ-4 rewrite): the previous `onNotification`
   * callback was deleted in this rewrite. Callers that want to observe
   * every inbound notification register `client.subscribe({}, handler)` after
   * construction; notifications flow through the per-subscription registry,
   * not through a top-level option.
   */
  onDisconnect?: (close: CloseInfo) => void;
  onReconnect?: (helloOk: ConnectResult) => void;
  logger?: WsClientLogger;
}

/**
 * WebSocket lifecycle: open → network/connect → active. On disconnect,
 * exponential backoff (1s base, 30s cap, jittered) retries the handshake via
 * `Effect.sleep` + `Schedule` so TestClock can drive it. Public API is
 * Effect-based — consumers run the returned Effects themselves (typically at
 * a framework or CLI edge).
 *
 * Transport: `@effect/platform/Socket.makeWebSocket` backed by
 * `@effect/platform-node/NodeSocket.layerWebSocketConstructor`. The Node
 * `WebSocketConstructor` layer is provided internally via `ManagedRuntime`
 * so callers' `connect()` / `sendRpc()` Effects have no extra requirement.
 */
export class MoltZapWsClient {
  private readonly stateRef: Ref.Ref<Option.Option<ConnState>>;
  private readonly malformedRef: Ref.Ref<number>;
  private readonly notificationsBufferRef: Ref.Ref<
    ReadonlyArray<DecodedNotification<AnyNotificationDefinition>>
  >;

  /**
   * Waiters keyed by notification descriptor identity. Each bucket is a FIFO
   * stack: delivery pops the most recently registered waiter (the tail).
   */
  private readonly notificationWaitersRef: Ref.Ref<
    HashMap.HashMap<
      AnyNotificationDefinition,
      ReadonlyArray<NotificationWaiter>
    >
  >;
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    Socket.WebSocketConstructor,
    never
  >;

  /**
   * Per-subscription notification registry. Spec #222 §5.3 (C4 + the
   * `RealClientEventSubscriber.subscribe` filter stub). Constructed
   * synchronously alongside the other Refs; `MoltZapWsClient.subscribe`
   * delegates to it directly.
   */
  private readonly subscribers: SubscriberRegistry;

  /**
   * Per-method handler registry for server-initiated RPCs. Survives
   * reconnects so apps register once and re-attach automatically when the
   * socket comes back. Each entry is invoked by the per-connection
   * dispatcher fiber when an appCallback request frame arrives.
   */
  private readonly appCallbackHandlersRef: Ref.Ref<
    HashMap.HashMap<AnyTaskCallbackRpcDefinition, ErasedServerRpcHandler>
  >;

  private closed = false;
  private reconnectFiber: Fiber.RuntimeFiber<void, never> | null = null;
  private _helloOk: ConnectResult | null = null;

  constructor(private readonly options: MoltZapWsClientOptions) {
    this.runtime = ManagedRuntime.make(NodeSocket.layerWebSocketConstructor);
    this.stateRef = this.runtime.runSync(
      Ref.make<Option.Option<ConnState>>(Option.none()),
    );
    this.malformedRef = this.runtime.runSync(Ref.make(0));
    this.notificationsBufferRef = this.runtime.runSync(
      Ref.make<ReadonlyArray<DecodedNotification<AnyNotificationDefinition>>>(
        [],
      ),
    );
    this.notificationWaitersRef = this.runtime.runSync(
      Ref.make<
        HashMap.HashMap<
          AnyNotificationDefinition,
          ReadonlyArray<NotificationWaiter>
        >
      >(HashMap.empty()),
    );
    // Registry construction is `Effect<…, never>`; running it sync here
    // matches every other Ref initializer in this constructor and
    // keeps `subscribers` non-nullable inside the class.
    this.subscribers = this.runtime.runSync(
      makeSubscriberRegistry({
        warn: (...args) => this.options.logger?.warn(...args),
      }),
    );
    this.appCallbackHandlersRef = this.runtime.runSync(
      Ref.make<
        HashMap.HashMap<AnyTaskCallbackRpcDefinition, ErasedServerRpcHandler>
      >(HashMap.empty()),
    );
  }

  /**
   * Register a handler for a server-initiated RPC method. Survives
   * reconnects — the registry lives on the client, not the per-connection
   * `ConnState`. Returns `Effect&lt;void>` that fails with
   * `DuplicateServerRpcHandlerError` if a handler for `method` is already
   * registered (shadowing the existing one would silently swap behaviour
   * mid-flight).
   *
   * The dispatcher fiber forked at `connect()` time picks up handlers via
   * `Ref.get` per-frame, so a registration made BEFORE `connect()` is
   * visible to the very first inbound appCallback request, and a registration
   * made AFTER `connect()` takes effect on the next inbound frame.
   */
  handleServerRpc<D extends AnyTaskCallbackRpcDefinition>(
    definition: D,
    handler: ServerRpcHandler<D>,
  ): Effect.Effect<void, DuplicateServerRpcHandlerError> {
    return Effect.gen(this, function* () {
      const swapped = yield* Ref.modify(this.appCallbackHandlersRef, (m) => {
        if (HashMap.has(m, definition)) return [false, m];
        return [
          true,
          HashMap.set(m, definition, handler as ErasedServerRpcHandler),
        ];
      });
      if (!swapped) {
        return yield* Effect.fail(
          new DuplicateServerRpcHandlerError({ method: definition.name }),
        );
      }
    });
  }

  get helloOk(): ConnectResult | null {
    return this._helloOk;
  }

  /**
   * Open the socket, perform network/connect, resolve with HelloOk. Fails
   * immediately on pre-open close or error.
   */
  connect(): Effect.Effect<ConnectResult, ConnectError> {
    return Effect.suspend(() => {
      if (this.closed) {
        return Effect.fail(makeNotConnectedError());
      }
      return this.connectEffect().pipe(
        // `makeWebSocket` requires `Socket.WebSocketConstructor`; our
        // internal Node layer provides it so callers' Effects stay
        // requirement-free (same public shape the legacy client had).
        Effect.provide(NodeSocket.layerWebSocketConstructor),
      );
    });
  }

  /**
   * Send an RPC. Fails with a typed error:
   *   - `NotConnectedError` if the socket isn't OPEN or closes mid-RPC
   *   - `RpcTimeoutError` after `RPC_TIMEOUT_MS` — no automatic retry
   *   - `RpcServerError` on a typed server-error frame
   *
   * Descriptor-backed RPC call. Callers pass the protocol descriptor, and the
   * client extracts the wire method only inside the encoder path.
   */
  sendRpc<D extends RpcDefinition<string, any, any>>(
    definition: D,
    params: ParamsOf<D>,
    opts?: RpcCallOptions,
  ): Effect.Effect<ResultOf<D>, ConnectError> {
    const timeoutMs = opts?.timeoutMs ?? RPC_TIMEOUT_MS;
    return this.sendRpcEffect(definition, params, timeoutMs);
  }

  /**
   * Register a per-subscription notification handler. Spec #222 §5.3 + OQ-2
   * (A): filter grammar is the three-field `SubscriptionFilter`
   * (`emissionTag` / `conversationId` / `notificationNamePrefix`). Returns a
   * handle whose `unsubscribe` Effect drops delivery starting with the
   * next inbound frame (OQ-3 A snapshot semantics).
   *
   * Subscription is legal pre-`connect()`; the registry buffers
   * registrations and starts dispatching once the reader fiber begins
   * producing frames. Fails with `NotConnectedError` only if the client
   * has been permanently torn down via `close()`.
   */
  subscribe(
    filter: SubscriptionFilter,
    handler: SubscriberHandler,
  ): Effect.Effect<NotificationSubscription, NotConnectedError> {
    return Effect.suspend(() => {
      if (this.closed) {
        return Effect.fail(makeNotConnectedError());
      }
      return this.subscribers.register(filter, handler);
    });
  }

  /**
   * Close the socket permanently (no reconnection). Writes a clean WebSocket
   * close frame (code 1000) before tearing down the scope so the server
   * observes a graceful handshake rather than an abrupt disconnect, preventing
   * lingering CLOSE_WAIT sockets on the server side.
   */
  close(): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      if (this.closed) return;
      const hasCompletedHandshake = this._helloOk !== null;
      this.closed = true;
      this._helloOk = null;
      if (this.reconnectFiber !== null) {
        const f = this.reconnectFiber;
        this.reconnectFiber = null;
        yield* Effect.forkDaemon(Fiber.interrupt(f));
      }
      yield* this.failAllPending(MSG_NOT_CONNECTED);
      yield* this.failAllNotificationWaiters(MSG_NOT_CONNECTED);
      // Drop every live subscription so handlers stop firing once
      // the client is permanently torn down. Idempotent.
      yield* this.subscribers.closeAll;
      const state = yield* Ref.getAndSet(this.stateRef, Option.none());
      if (Option.isSome(state)) {
        if (hasCompletedHandshake) {
          yield* state.value
            .write(new Socket.CloseEvent(NORMAL_CLOSE_CODE, "normal"))
            .pipe(Effect.orDie);
          yield* Scope.close(state.value.scope, Exit.void);
        } else {
          this.runtime.runFork(Scope.close(state.value.scope, Exit.void));
        }
        // The dispatcher Scope is NOT bound to the socket Scope (see
        // ConnState doc): tear it down via runFork so this Effect
        // remains sync-runnable for callers using
        // `runSync(client.close())`. Closing the dispatcher Scope
        // interrupts the drain fiber via Scope finalizers; the
        // bounded queue is then garbage-collected.
        this.runtime.runFork(
          Scope.close(state.value.dispatcherScope, Exit.void),
        );
      }
    }).pipe(
      Effect.asVoid,
      Effect.ensuring(
        Effect.sync(() => {
          this.runtime.dispose();
        }),
      ),
    );
  }

  /**
   * Wait for the next inbound notification matching `definition`.
   * Consumes a buffered match if present; otherwise awaits the next match
   * with a per-call timeout.
   */
  waitForNotification<D extends AnyNotificationDefinition>(
    definition: D,
    timeoutMs = EVENT_WAIT_TIMEOUT_MS,
  ): Effect.Effect<DecodedNotification<D>, Error> {
    return Effect.gen(this, function* () {
      const buffered = yield* this.takeBufferedNotification(definition);
      if (buffered !== null) return buffered;
      return yield* this.awaitNotification(definition, timeoutMs);
    });
  }

  private takeBufferedNotification<D extends AnyNotificationDefinition>(
    definition: D,
  ): Effect.Effect<DecodedNotification<D> | null> {
    return Ref.modify(this.notificationsBufferRef, (frames) => {
      for (const [idx, frame] of frames.entries()) {
        if (!acceptTypedNotification(definition, frame)) continue;
        const next = [...frames.slice(0, idx), ...frames.slice(idx + 1)];
        return [frame, next];
      }
      return [null, frames];
    });
  }

  private awaitNotification<D extends AnyNotificationDefinition>(
    definition: D,
    timeoutMs: number,
  ): Effect.Effect<DecodedNotification<D>, Error> {
    return Effect.gen(this, function* () {
      const deferred = yield* Deferred.make<DecodedNotification<D>, Error>();
      const waiter = this.makeNotificationWaiter(definition, deferred);
      yield* this.addNotificationWaiter(definition, waiter);
      return yield* Deferred.await(deferred).pipe(
        Effect.timeoutFail({
          duration: `${timeoutMs} millis`,
          onTimeout: () =>
            new Error(`Timeout waiting for notification: ${definition.name}`),
        }),
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? this.removeNotificationWaiter(definition, waiter)
            : Effect.void,
        ),
      );
    });
  }

  private makeNotificationWaiter<D extends AnyNotificationDefinition>(
    definition: D,
    deferred: Deferred.Deferred<DecodedNotification<D>, Error>,
  ): NotificationWaiter {
    return {
      definition,
      complete: (notification) =>
        acceptTypedNotification(definition, notification)
          ? Deferred.succeed(deferred, notification).pipe(Effect.asVoid)
          : Effect.void,
      fail: (error) => Deferred.fail(deferred, error).pipe(Effect.asVoid),
    };
  }

  private addNotificationWaiter(
    definition: AnyNotificationDefinition,
    waiter: NotificationWaiter,
  ): Effect.Effect<void> {
    return Ref.update(this.notificationWaitersRef, (m) => {
      const existing = HashMap.get(m, definition);
      const next =
        existing._tag === "Some" ? [...existing.value, waiter] : [waiter];
      return HashMap.set(m, definition, next);
    });
  }

  private removeNotificationWaiter(
    definition: AnyNotificationDefinition,
    waiter: NotificationWaiter,
  ): Effect.Effect<void> {
    return Ref.update(this.notificationWaitersRef, (m) =>
      removeWaiter(m, definition, waiter),
    );
  }

  /**
   * Return all buffered notifications and clear the buffer. Synchronous.
   * Frames are pre-validation (`params: unknown`) — buffer holds the
   * raw shape produced by the wire decoder.
   */
  drainNotifications(): DecodedNotification<AnyNotificationDefinition>[] {
    const snapshot = this.runtime.runSync(Ref.get(this.notificationsBufferRef));
    this.runtime.runSync(Ref.set(this.notificationsBufferRef, []));
    return [...snapshot];
  }

  /** Close the socket without marking as permanently closed, triggering reconnection. */
  disconnect(): Effect.Effect<void, never> {
    return Effect.sync(() => this.disconnectSync());
  }

  private disconnectSync(): void {
    const state = this.runtime.runSync(Ref.get(this.stateRef));
    if (Option.isNone(state)) return;
    // Detach from state first so sendRpc fails fast while we tear down.
    this.runtime.runSync(Ref.set(this.stateRef, Option.none()));
    this.runtime.runFork(this.failConnectionPending(state.value));
    // Interrupt the reader fiber. runRaw exits, the socket scope closes,
    // ws.close(1000) fires as part of that teardown.
    this.runtime.runFork(Fiber.interrupt(state.value.readerFiber));
    // Close the per-connection scope as a belt-and-braces guarantee.
    this.runtime.runFork(Scope.close(state.value.scope, Exit.void));
    // Tear down the task-callback dispatcher Scope (off-scope, see
    // ConnState doc). runFork so disconnectSync stays synchronous for
    // callers using `runSync(client.disconnect())`. Closing the
    // dispatcher Scope interrupts the drain fiber via Scope
    // finalizers.
    this.runtime.runFork(Scope.close(state.value.dispatcherScope, Exit.void));
  }

  private notifyDisconnect(close: CloseInfo): Effect.Effect<void> {
    return Effect.sync(() => {
      try {
        this.options.onDisconnect?.(close);
      } catch (err) {
        this.options.logger?.warn("onDisconnect handler threw", err);
      }
    });
  }

  private connectEffect(): Effect.Effect<
    ConnectResult,
    ConnectError,
    Socket.WebSocketConstructor
  > {
    return Effect.gen(this, function* () {
      const url = this.webSocketUrl();
      const scope = yield* Scope.make();
      const socket = yield* this.openSocket(url, scope);
      const write = yield* Scope.extend(socket.writer, scope);
      const jsonRpcClient = yield* Scope.extend(
        makeJsonRpcClient({
          write: (raw) => write(raw),
          idPrefix: "rpc",
        }),
        scope,
      );
      const handshakeSettled = yield* Deferred.make<
        ConnectResult,
        ConnectError
      >();
      const dispatcher = yield* this.startTaskCallbackDispatcher(write);
      const readerFiber = this.runtime.runFork(
        this.readerEffect(socket, handshakeSettled, dispatcher.dispatcherScope),
      );

      yield* this.publishConnectionState({
        write,
        readerFiber,
        scope,
        jsonRpcClient,
        handshakeSettled,
        taskCallbackQueue: dispatcher.taskCallbackQueue,
        dispatcherScope: dispatcher.dispatcherScope,
      });
      return yield* this.awaitConnectAuth(handshakeSettled);
    });
  }

  private webSocketUrl(): string {
    return this.options.serverUrl.replace(/^http/, "ws") + "/ws";
  }

  private openSocket(
    url: string,
    scope: Scope.CloseableScope,
  ): Effect.Effect<
    ClientWebSocket,
    NotConnectedError,
    Socket.WebSocketConstructor
  > {
    const openTimeout = Duration.seconds(WEB_SOCKET_OPEN_TIMEOUT_SECONDS);
    return Scope.extend(Socket.makeWebSocket(url, { openTimeout }), scope).pipe(
      Effect.timeoutFail({
        duration: openTimeout,
        onTimeout: makeNotConnectedError,
      }),
      Effect.catchAllCause((cause) =>
        Effect.zipRight(
          Effect.sync(() =>
            this.options.logger?.warn("WebSocket open failed", cause),
          ),
          Effect.sync(() => {
            this.runtime.runFork(Scope.close(scope, Exit.void));
          }).pipe(Effect.zipRight(Effect.fail(makeNotConnectedError()))),
        ),
      ),
    );
  }

  private startTaskCallbackDispatcher(
    write: ConnState["write"],
  ): Effect.Effect<TaskCallbackDispatcher> {
    return Effect.gen(this, function* () {
      const dispatcherScope = yield* Scope.make();
      const taskCallbackQueue = yield* Queue.bounded<DecodedServerRequest>(
        TASK_CALLBACK_QUEUE_CAPACITY,
      );
      const drainEffect = Effect.forever(
        Queue.take(taskCallbackQueue).pipe(
          Effect.flatMap((req) =>
            this.dispatchInboundServerRequest(req, write),
          ),
        ),
      );
      yield* Effect.forkIn(drainEffect, dispatcherScope);
      return { dispatcherScope, taskCallbackQueue };
    });
  }

  private readerEffect(
    socket: ClientWebSocket,
    handshakeSettled: Deferred.Deferred<ConnectResult, ConnectError>,
    dispatcherScope: Scope.CloseableScope,
  ): Effect.Effect<void, Socket.SocketError> {
    return socket
      .runRaw((data) =>
        this.handleIncoming(
          typeof data === "string" ? data : UTF8_DECODER.decode(data),
        ),
      )
      .pipe(
        Effect.onExit((exit) =>
          this.handleReaderExit(exit, handshakeSettled, dispatcherScope),
        ),
      );
  }

  private handleReaderExit(
    exit: Exit.Exit<void, Socket.SocketError>,
    handshakeSettled: Deferred.Deferred<ConnectResult, ConnectError>,
    dispatcherScope: Scope.CloseableScope,
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      if (Exit.isFailure(exit)) {
        this.options.logger?.warn("WebSocket error", exit.cause);
      }
      this._helloOk = null;
      yield* this.failAllPending(MSG_NOT_CONNECTED);
      yield* Deferred.fail(handshakeSettled, makeNotConnectedError()).pipe(
        Effect.ignore,
      );
      yield* Ref.set(this.stateRef, Option.none());
      this.runtime.runFork(Scope.close(dispatcherScope, Exit.void));
      yield* this.notifyDisconnect(extractCloseInfo(exit));
      if (!this.closed) this.scheduleReconnect();
    });
  }

  private publishConnectionState(state: ConnState): Effect.Effect<void> {
    return Ref.set(this.stateRef, Option.some(state));
  }

  private awaitConnectAuth(
    handshakeSettled: Deferred.Deferred<ConnectResult, ConnectError>,
  ): Effect.Effect<ConnectResult, ConnectError> {
    const authEffect = this.sendRpc(Connect, {
      agentKey: this.options.agentKey,
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
    });
    return Effect.raceFirst(authEffect, Deferred.await(handshakeSettled)).pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          this._helloOk = value;
        }),
      ),
    );
  }

  private sendRpcEffect<D extends RpcDefinition<string, any, any>>(
    definition: D,
    params: ParamsOf<D>,
    timeoutMs: number,
  ): Effect.Effect<ResultOf<D>, ConnectError> {
    return Effect.gen(this, function* () {
      const state = yield* Ref.get(this.stateRef);
      if (Option.isNone(state)) {
        return yield* Effect.fail(makeNotConnectedError());
      }
      return yield* state.value.jsonRpcClient.call(definition, params).pipe(
        Effect.timeoutFail({
          duration: `${timeoutMs} millis`,
          onTimeout: () =>
            new RpcTimeoutError({ method: definition.name, timeoutMs }),
        }),
      );
    });
  }

  /**
   * Write a "queue-full" error response back to the server when the
   * task-callback executor queue is saturated. Bounded-queue offer
   * returns `false` rather than blocking; we surface that to the
   * server's `Deferred.await` so it settles deterministically.
   */
  private writeQueueFullRejection(
    requestId: JsonRpcId,
    write: ConnState["write"],
  ): Effect.Effect<void, never> {
    const reply: ResponseFrame = encodeErrorResponse(requestId, {
      code: -32000,
      message: `Server busy: task-callback executor queue full (capacity=${TASK_CALLBACK_QUEUE_CAPACITY})`,
    });
    return write(JSON.stringify(reply)).pipe(
      Effect.catchAll((werr) =>
        Effect.sync(() =>
          this.options.logger?.warn(
            "task-callback queue-full rejection write failed",
            werr,
          ),
        ),
      ),
    );
  }

  /**
   * Dispatch one inbound appCallback request to the registered handler, encode
   * the response, and write it back to the server. Errors are projected
   * onto an error response so the server's `Deferred.await` always
   * settles deterministically — never hangs on a missing or crashing
   * handler.
   *
   * Cases:
   *   - Handler registered + Effect succeeds → encode `result`.
   *   - Handler registered + Effect fails (RpcServerError) → encode
   *     `error` from the tag.
   *   - Handler registered + Effect defects (untagged crash) →
   *     encode generic InternalError, log the cause.
   *   - No handler registered → encode MethodNotFound error response.
   */
  private dispatchInboundServerRequest(
    request: DecodedServerRequest,
    write: ConnState["write"],
  ): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      const reply = yield* this.buildInboundServerReply(request);
      yield* this.writeInboundServerReply(write, reply);
    });
  }

  private buildInboundServerReply(
    request: DecodedServerRequest,
  ): Effect.Effect<ResponseFrame, never> {
    return Effect.gen(this, function* () {
      const handlers = yield* Ref.get(this.appCallbackHandlersRef);
      const rpcServer = makeJsonRpcServer<ServerRpcContext>(
        this.appCallbackRpcHandlers(handlers),
        null,
      );
      return yield* rpcServer.handle(request.frame, {
        requestId: request.id,
        definition: request.definition,
      });
    });
  }

  private appCallbackRpcHandlers(
    handlers: HashMap.HashMap<
      AnyTaskCallbackRpcDefinition,
      ErasedServerRpcHandler
    >,
  ): ReadonlyArray<RpcHandler<ServerRpcContext>> {
    return Array.from(
      HashMap.entries(handlers),
      ([definition, appHandler]): RpcHandler<ServerRpcContext> => ({
        definition,
        handle: (params, ctx) => appHandler(params, { ...ctx, definition }),
      }),
    );
  }

  private writeInboundServerReply(
    write: ConnState["write"],
    reply: ResponseFrame,
  ): Effect.Effect<void, never> {
    return write(JSON.stringify(reply)).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() =>
          this.options.logger?.warn("appCallback response write failed", err),
        ),
      ),
    );
  }

  private recordMalformedFrame(err: {
    readonly raw: string;
  }): Effect.Effect<null> {
    return Effect.gen(this, function* () {
      const count = yield* Ref.updateAndGet(this.malformedRef, (n) => n + 1);
      if (count === 1 || count % MALFORMED_LOG_EVERY === 0) {
        this.options.logger?.warn(
          `Malformed frame (#${count}):`,
          err.raw.slice(0, MALFORMED_FRAME_PREVIEW_CHARS),
        );
      }
      return null;
    });
  }

  private handleDecodedResponse(
    decoded: DecodedIncomingResponse,
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const state = yield* Ref.get(this.stateRef);
      if (Option.isNone(state)) return;
      yield* state.value.jsonRpcClient
        .resolve(decoded.frame)
        .pipe(Effect.asVoid);
    });
  }

  private handleDecodedServerRequest(
    decoded: DecodedServerRequest,
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const state = yield* Ref.get(this.stateRef);
      if (Option.isNone(state)) return;
      const offered = yield* Queue.offer(
        state.value.taskCallbackQueue,
        decoded,
      );
      if (!offered) {
        yield* this.writeQueueFullRejection(decoded.id, state.value.write);
      }
    });
  }

  private takeNotificationWaiter(
    decoded: DecodedIncomingNotification,
  ): Effect.Effect<NotificationWaiter | null> {
    return Ref.modify(this.notificationWaitersRef, (waitersMap) => {
      const bucket = HashMap.get(waitersMap, decoded.definition);
      if (bucket._tag === "None" || bucket.value.length === 0) {
        return [null as NotificationWaiter | null, waitersMap];
      }
      const arr = bucket.value;
      const chosen = arr[arr.length - 1]!;
      const rest = arr.slice(0, -1);
      const nextMap =
        rest.length === 0
          ? HashMap.remove(waitersMap, decoded.definition)
          : HashMap.set(waitersMap, decoded.definition, rest);
      return [chosen, nextMap];
    });
  }

  private bufferNotification(
    decoded: DecodedIncomingNotification,
  ): Effect.Effect<void> {
    return Ref.update(this.notificationsBufferRef, (buffer) => {
      const appended = [...buffer, decoded];
      return appended.length > MAX_EVENT_BUFFER
        ? appended.slice(-MAX_EVENT_BUFFER)
        : appended;
    });
  }

  private handleDecodedNotification(
    decoded: DecodedIncomingNotification,
  ): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      yield* this.subscribers.dispatch(decoded);
      const delivered = yield* this.takeNotificationWaiter(decoded);
      if (delivered !== null) {
        yield* delivered.complete(decoded);
        return;
      }
      yield* this.bufferNotification(decoded);
    });
  }

  private handleDecodedFrame(
    decoded: DecodedIncomingFrame,
  ): Effect.Effect<void> {
    switch (decoded._tag) {
      case "ResponseSuccess":
      case "ResponseError":
        return this.handleDecodedResponse(decoded);
      case "ServerRequest":
        return this.handleDecodedServerRequest(decoded);
      case "Notification":
        return this.handleDecodedNotification(decoded);
    }
  }

  /**
   * Route an inbound frame. Malformed frames are logged + dropped; notification
   * frames dispatch to `onNotification` after the shape check.
   */
  private handleIncoming(raw: string): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const decodedFrames = yield* decodeFrames(raw).pipe(
        Effect.catchTag("MalformedFrameError", (err) =>
          this.recordMalformedFrame(err),
        ),
      );
      if (decodedFrames === null) return;

      for (const decoded of decodedFrames) {
        yield* this.handleDecodedFrame(decoded);
      }
    });
  }

  /** Fail every outstanding notification waiter with `message` and clear the map. */
  private failAllNotificationWaiters(message: string): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const waiters = yield* Ref.getAndSet(
        this.notificationWaitersRef,
        HashMap.empty<
          AnyNotificationDefinition,
          ReadonlyArray<NotificationWaiter>
        >(),
      );
      for (const [, bucket] of HashMap.entries(waiters)) {
        for (const w of bucket) {
          yield* w.fail(new Error(message));
        }
      }
    });
  }

  private failConnectionPending(state: ConnState): Effect.Effect<void> {
    return state.jsonRpcClient.failAllPending(
      new NotConnectedError({ message: MSG_NOT_CONNECTED }),
    );
  }

  private failAllPending(message: string): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const state = yield* Ref.get(this.stateRef);
      if (Option.isNone(state)) return;
      yield* state.value.jsonRpcClient.failAllPending(
        new NotConnectedError({ message }),
      );
    });
  }

  /**
   * Schedule a reconnect attempt. Jittered exponential backoff (1s base,
   * 30s cap) routed through `Effect.sleep` so `TestClock` can drive it.
   */
  private scheduleReconnect(): void {
    if (this.closed || this.reconnectFiber !== null) return;

    const attempt = this.connectEffect().pipe(
      Effect.tap((helloOk) =>
        Effect.sync(() => {
          try {
            this.options.onReconnect?.(helloOk);
          } catch (err) {
            this.options.logger?.warn("onReconnect handler threw", err);
          }
        }),
      ),
      Effect.either,
      Effect.flatMap(
        Either.match({
          onLeft: () =>
            Effect.fail(
              new ReconnectAttemptFailedError({
                reason: "reconnect attempt failed",
              }),
            ),
          onRight: (value) => Effect.succeed(value),
        }),
      ),
    );

    const backoff = Schedule.exponential(
      Duration.millis(BASE_RECONNECT_DELAY_MS),
      RECONNECT_BACKOFF_FACTOR,
    ).pipe(
      Schedule.either(Schedule.spaced(Duration.millis(MAX_RECONNECT_DELAY_MS))),
      Schedule.jittered,
    );

    const loop: Effect.Effect<void, never> = attempt.pipe(
      Effect.retry(backoff),
      Effect.asVoid,
      Effect.catchAll(() => Effect.void),
      Effect.ensuring(
        Effect.sync(() => {
          this.reconnectFiber = null;
        }),
      ),
      Effect.provide(NodeSocket.layerWebSocketConstructor),
    );

    this.reconnectFiber = this.runtime.runFork(loop);
  }
}
