import * as Socket from "@effect/platform/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  Cause,
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
  NotConnectedError,
  RpcServerError,
  RpcTimeoutError,
  type AnyTaskCallbackRpcDefinition,
  type AnyNotificationDefinition,
  type JsonRpcId,
  type ParamsOf,
  type RequestFrame,
  type ResponseFrame,
  type ResultOf,
  type RpcDefinition,
} from "@moltzap/protocol";
import { DuplicateServerRpcHandlerError } from "./runtime/errors.js";
import { decodeFrames, type DecodedNotification } from "./runtime/frame.js";
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

/** Reconnect backoff: 1s base, doubling per attempt up to the cap. */
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RECONNECT_BACKOFF_FACTOR = 2;
const NORMAL_CLOSE_CODE = 1000;
const EVENT_WAIT_TIMEOUT_MS = 5000;
const WEB_SOCKET_OPEN_TIMEOUT_SECONDS = 10;
const MALFORMED_FRAME_PREVIEW_CHARS = 200;
const JSON_RPC_INTERNAL_ERROR_CODE = -32603;

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
const MSG_RPC_ERROR_FALLBACK = "RPC error";

const UTF8_DECODER = new TextDecoder("utf-8");

const makeNotConnectedError = (): NotConnectedError =>
  new NotConnectedError({ message: MSG_NOT_CONNECTED });

type ConnectResult = ResultOf<typeof Connect>;

/** Tagged error type for any pending-RPC Deferred. */
type PendingError = RpcServerError | NotConnectedError | RpcTimeoutError;

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
  /** Settled when the reader fiber exits, letting `connect()` race against
   * pre-open close and fail fast instead of waiting the RPC timeout. */
  readonly handshakeSettled: Deferred.Deferred<ConnectResult, PendingError>;
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

/**
 * Internal type for a decoded inbound task-callback request handed off
 * to the global queue. Mirrors `DecodedServerRequest` from
 * `runtime/frame.ts` but lives here so the queue does not need a
 * `runtime/` import cycle.
 */
interface DecodedServerRequest {
  readonly id: JsonRpcId;
  readonly definition: AnyTaskCallbackRpcDefinition;
  readonly params: unknown;
}

/**
 * Handler signature for `handleServerRpc`. The handler returns an
 * `Effect<unknown, RpcServerError>` — success values are encoded as the
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

/** Notifications are pre-validated by the wire decoder
 * (`decodeNotification` in `@moltzap/protocol`) — fail-close on unknown
 * methods or bad params. Buffer + waiters hold the validated shape
 * directly; no separate Raw|Unknown lift remains. */

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
  private readonly pendingRef: Ref.Ref<
    HashMap.HashMap<JsonRpcId, Deferred.Deferred<unknown, PendingError>>
  >;
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

  private requestCounter = 0;
  private closed = false;
  private reconnectFiber: Fiber.RuntimeFiber<void, never> | null = null;
  private _helloOk: ConnectResult | null = null;

  constructor(private readonly options: MoltZapWsClientOptions) {
    this.runtime = ManagedRuntime.make(NodeSocket.layerWebSocketConstructor);
    this.pendingRef = this.runtime.runSync(
      Ref.make<
        HashMap.HashMap<JsonRpcId, Deferred.Deferred<unknown, PendingError>>
      >(HashMap.empty()),
    );
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
   * `ConnState`. Returns `Effect<void>` that fails with
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

  /** Open the socket, perform network/connect, resolve with HelloOk. Fails
   * immediately on pre-open close or error. */
  connect(): Effect.Effect<
    ConnectResult,
    NotConnectedError | RpcTimeoutError | RpcServerError
  > {
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
  ): Effect.Effect<
    ResultOf<D>,
    NotConnectedError | RpcTimeoutError | RpcServerError
  > {
    const timeoutMs = opts?.timeoutMs ?? RPC_TIMEOUT_MS;
    return this.sendRpcEffect(definition, params, timeoutMs).pipe(
      Effect.flatMap((result) =>
        definition.validateResult(result)
          ? Effect.succeed(result)
          : Effect.fail(
              new RpcServerError({
                code: JSON_RPC_INTERNAL_ERROR_CODE,
                message: `Invalid result for method: ${definition.name}`,
                data: result,
              }),
            ),
      ),
    );
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
          void this.runtime.dispose();
        }),
      ),
    );
  }

  /** Wait for the next inbound notification matching `definition`.
   * Consumes a buffered match if present; otherwise awaits the next match
   * with a per-call timeout. */
  waitForNotification<D extends AnyNotificationDefinition>(
    definition: D,
    timeoutMs = EVENT_WAIT_TIMEOUT_MS,
  ): Effect.Effect<DecodedNotification<D>, Error> {
    return Effect.gen(this, function* () {
      const buffered = yield* Ref.modify(
        this.notificationsBufferRef,
        (frames) => {
          for (const [idx, frame] of frames.entries()) {
            if (!acceptTypedNotification(definition, frame)) continue;
            const next = [...frames.slice(0, idx), ...frames.slice(idx + 1)];
            return [frame, next];
          }
          return [null, frames];
        },
      );
      if (buffered !== null) return buffered;

      const deferred = yield* Deferred.make<DecodedNotification<D>, Error>();
      const waiter: NotificationWaiter = {
        definition,
        complete: (notification) =>
          acceptTypedNotification(definition, notification)
            ? Deferred.succeed(deferred, notification).pipe(Effect.asVoid)
            : Effect.void,
        fail: (error) => Deferred.fail(deferred, error).pipe(Effect.asVoid),
      };
      yield* Ref.update(this.notificationWaitersRef, (m) => {
        const existing = HashMap.get(m, definition);
        const next =
          existing._tag === "Some" ? [...existing.value, waiter] : [waiter];
        return HashMap.set(
          m,
          definition,
          next as ReadonlyArray<NotificationWaiter>,
        );
      });
      return yield* Deferred.await(deferred).pipe(
        Effect.timeoutFail({
          duration: `${timeoutMs} millis`,
          onTimeout: () =>
            new Error(`Timeout waiting for notification: ${definition.name}`),
        }),
        Effect.onExit((exit) =>
          exit._tag === "Failure"
            ? Ref.update(this.notificationWaitersRef, (m) =>
                removeWaiter(m, definition, waiter),
              )
            : Effect.void,
        ),
      );
    });
  }

  /** Return all buffered notifications and clear the buffer. Synchronous.
   * Frames are pre-validation (`params: unknown`) — buffer holds the
   * raw shape produced by the wire decoder. */
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
    // Fail pendings via runFork — `failAllPending` yields through
    // `Deferred.fail` (not safe for runSync). Fire-and-forget: the reader
    // fiber's onExit will also drain on interrupt; duplicate drain is
    // harmless because `failAllPending` resets the pendingRef atomically.
    this.runtime.runFork(this.failAllPending(MSG_NOT_CONNECTED));
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

  private connectEffect(): Effect.Effect<
    ConnectResult,
    NotConnectedError | RpcTimeoutError | RpcServerError,
    Socket.WebSocketConstructor
  > {
    return Effect.gen(this, function* () {
      const url = this.options.serverUrl.replace(/^http/, "ws") + "/ws";

      // Fresh scope per connect attempt. Held by the client (not the caller's
      // fiber) so the reader + writer outlive the outer `connect()` Effect.
      const scope = yield* Scope.make();

      // Map Socket open failures (SocketGenericError / SocketCloseError) to
      // NotConnectedError so callers see a single typed error.
      const openTimeout = Duration.seconds(WEB_SOCKET_OPEN_TIMEOUT_SECONDS);
      const socket = yield* Scope.extend(
        Socket.makeWebSocket(url, { openTimeout }),
        scope,
      ).pipe(
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

      const write = yield* Scope.extend(socket.writer, scope);

      // Settled first by whichever fires: the network/connect response, or
      // reader-fiber exit on any close/error before handshake.
      const handshakeSettled = yield* Deferred.make<
        ConnectResult,
        PendingError
      >();

      // Cutover (#533) — single bounded global queue + single drain
      // fiber replaces the pre-cutover partitioned dispatcher. The
      // queue capacity (`TASK_CALLBACK_QUEUE_CAPACITY` = 8192)
      // preserves today's 256×32 burst envelope. The drain fiber
      // takes one request at a time and runs the registered handler
      // serially; the only remaining task-callback descriptor today
      // is `dispatch/authorize`, which the recipient may not handle
      // concurrently with itself.
      //
      // Dispatcher Scope is allocated independently of the per-connect
      // socket Scope (`scope` above). Closing it interrupts the drain
      // fiber via Scope finalizers; teardown from `close()` /
      // `disconnectSync()` is `runFork(Scope.close(...))`, mirroring
      // the reader-fiber ownership pattern (off-Scope so
      // `runSync(client.close())` doesn't yield through the runtime
      // — load-bearing regression gate at
      // `ws-client.test.ts:1233-1259`).
      const dispatcherScope = yield* Scope.make();
      const taskCallbackQueue = yield* Queue.bounded<DecodedServerRequest>(
        TASK_CALLBACK_QUEUE_CAPACITY,
      );
      // Drain fiber: serialize handler execution. Forked into the
      // off-Scope `dispatcherScope` so it is interrupted exactly when
      // the dispatcher Scope closes, not when the socket Scope closes.
      const drainEffect = Effect.forever(
        Queue.take(taskCallbackQueue).pipe(
          Effect.flatMap((req) =>
            this.dispatchInboundServerRequest(req, write),
          ),
        ),
      );
      yield* Effect.forkIn(drainEffect, dispatcherScope);

      // Use `onExit` (not `tapErrorCause`) so the clean-close path also
      // triggers pending-drain. `@effect/platform/Socket` treats code 1000
      // as a SUCCESS exit, so error-only handlers miss it and pending RPCs
      // would hang forever.
      const readerEffect = socket
        .runRaw((data) =>
          this.handleIncoming(
            typeof data === "string" ? data : UTF8_DECODER.decode(data),
          ),
        )
        .pipe(
          Effect.onExit((exit) =>
            Effect.gen(this, function* () {
              if (Exit.isFailure(exit)) {
                this.options.logger?.warn("WebSocket error", exit.cause);
              }
              this._helloOk = null;
              yield* this.failAllPending(MSG_NOT_CONNECTED);
              // Unblock any `connect()` still awaiting the handshake.
              yield* Deferred.fail(
                handshakeSettled,
                makeNotConnectedError(),
              ).pipe(Effect.ignore);
              // Clear connection state BEFORE the appCallback teardown so
              // `sendRpc` and observers see the closed state immediately.
              // Awaiting `Fiber.interrupt` would block this branch on a
              // slow appCallback handler still draining (codex P2).
              yield* Ref.set(this.stateRef, Option.none());
              // Tear down the task-callback dispatcher Scope on
              // socket-level close (e.g. server-initiated). `close()`
              // / `disconnectSync()` already handle their own
              // teardown for client-initiated paths; this branch
              // covers the case where the server closes us. Forked
              // so a slow handler does not delay the rest of the
              // disconnect path. Idempotent with the explicit
              // teardown in close().
              this.runtime.runFork(Scope.close(dispatcherScope, Exit.void));
              // Spec #222 §5.4 (V7): project the reader-fiber exit onto
              // a typed `CloseInfo` and pass it to `onDisconnect`. Pure
              // total classifier — see runtime/close-info.ts.
              const close = extractCloseInfo(exit);
              yield* Effect.sync(() => {
                try {
                  this.options.onDisconnect?.(close);
                } catch (err) {
                  this.options.logger?.warn("onDisconnect handler threw", err);
                }
              });
              if (!this.closed) {
                this.scheduleReconnect();
              }
            }),
          ),
        );

      // Fork the reader on the CLIENT's runtime (not the caller's fiber) so
      // it outlives the outer `connect()`. Otherwise the caller's fiber tree
      // finalizes on return, interrupts the reader, and `onExit` clears
      // `_helloOk` behind a caller that believed connect() succeeded.
      const readerFiber = this.runtime.runFork(readerEffect);

      // Publish state BEFORE network/connect: the write goes through
      // `sendRpcEffect`, which reads `stateRef`.
      yield* Ref.set(
        this.stateRef,
        Option.some({
          write,
          readerFiber,
          scope,
          handshakeSettled,
          taskCallbackQueue,
          dispatcherScope,
        }),
      );

      const authEffect = this.sendRpc(Connect, {
        agentKey: this.options.agentKey,
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
      });

      // Race the network/connect response against the handshakeSettled deferred
      // `raceFirst` (not `race`) — `race` waits for the loser when the
      // winner fails, so a typed network/connect error would hang behind the
      // still-pending handshake-watchdog Deferred.
      const result = yield* Effect.raceFirst(
        authEffect,
        Deferred.await(handshakeSettled),
      ).pipe(
        Effect.tap((value) =>
          Effect.sync(() => {
            this._helloOk = value;
          }),
        ),
      );

      return result;
    });
  }

  private sendRpcEffect<D extends RpcDefinition<string, any, any>>(
    definition: D,
    params: ParamsOf<D>,
    timeoutMs: number,
  ): Effect.Effect<
    ResultOf<D>,
    NotConnectedError | RpcTimeoutError | RpcServerError
  > {
    return Effect.gen(this, function* () {
      const method = definition.name;
      const state = yield* Ref.get(this.stateRef);
      if (Option.isNone(state)) {
        return yield* Effect.fail(makeNotConnectedError());
      }

      const frame: RequestFrame = definition.encodeRequest(
        `rpc-${++this.requestCounter}`,
        params,
      );
      const id = frame.id;

      // Register the Deferred BEFORE writing — write yields, reader could
      // close + failAllPending before we register, leaving us awaiting a
      // never-resolved Deferred.
      const deferred = yield* Deferred.make<unknown, PendingError>();
      yield* Ref.update(this.pendingRef, (m) => HashMap.set(m, id, deferred));

      const writeAttempt = Effect.either(
        state.value.write(JSON.stringify(frame)),
      );
      const earlyFailure: Effect.Effect<null> = Deferred.await(deferred).pipe(
        Effect.catchAll(() => Effect.succeed(null)),
        Effect.as(null),
      );
      const writeRace = yield* Effect.race(writeAttempt, earlyFailure);
      const writeFailure =
        writeRace === null
          ? null
          : Either.match(writeRace, {
              onLeft: (err) => err,
              onRight: () => null,
            });
      if (writeFailure !== null) {
        this.options.logger?.warn("ws.send failed", writeFailure);
        yield* Ref.update(this.pendingRef, (m) => HashMap.remove(m, id));
        return yield* Effect.fail(makeNotConnectedError());
      }

      const result = yield* Deferred.await(deferred).pipe(
        Effect.timeoutFail({
          duration: `${timeoutMs} millis`,
          onTimeout: () => new RpcTimeoutError({ method, timeoutMs }),
        }),
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Ref.update(this.pendingRef, (m) => HashMap.remove(m, id))
            : Effect.void,
        ),
      );

      if (!definition.validateResult(result)) {
        return yield* Effect.fail(
          new RpcServerError({
            code: JSON_RPC_INTERNAL_ERROR_CODE,
            message: `Invalid result for method: ${definition.name}`,
            data: result,
          }),
        );
      }
      return result as ResultOf<D>;
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
      const handlers = yield* Ref.get(this.appCallbackHandlersRef);
      const lookup = HashMap.get(handlers, request.definition);
      const buildReply =
        lookup._tag === "None"
          ? Effect.succeed(
              encodeErrorResponse(request.id, {
                code: -32601,
                message: "No handler registered for app callback descriptor",
              }) satisfies ResponseFrame,
            )
          : lookup
              .value(request.params, {
                requestId: request.id,
                definition: request.definition,
              })
              .pipe(
                Effect.match({
                  onSuccess: (result) =>
                    request.definition.encodeResponse(
                      request.id,
                      result,
                    ) satisfies ResponseFrame,
                  onFailure: (err) =>
                    encodeErrorResponse(request.id, {
                      code: err.code,
                      message: err.message,
                      ...(err.data !== undefined ? { data: err.data } : {}),
                    }) satisfies ResponseFrame,
                }),
                Effect.catchAllCause((cause) =>
                  Effect.sync(() => {
                    this.options.logger?.warn(
                      "appCallback handler defected",
                      Cause.pretty(cause),
                    );
                    return encodeErrorResponse(request.id, {
                      code: -32603,
                      message: "Internal error",
                    }) satisfies ResponseFrame;
                  }),
                ),
              );
      const reply = yield* buildReply;
      yield* write(JSON.stringify(reply)).pipe(
        Effect.catchAll((err) =>
          Effect.sync(() =>
            this.options.logger?.warn("appCallback response write failed", err),
          ),
        ),
      );
    });
  }

  /** Route an inbound frame. Malformed frames are logged + dropped; notification
   * frames dispatch to `onNotification` after the shape check. */
  private handleIncoming(raw: string): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const decodedFrames = yield* decodeFrames(raw).pipe(
        Effect.catchTag("MalformedFrameError", (err) =>
          Effect.gen(this, function* () {
            const n = yield* Ref.updateAndGet(this.malformedRef, (c) => c + 1);
            if (n === 1 || n % MALFORMED_LOG_EVERY === 0) {
              this.options.logger?.warn(
                `Malformed frame (#${n}):`,
                err.raw.slice(0, MALFORMED_FRAME_PREVIEW_CHARS),
              );
            }
            return null;
          }),
        ),
      );
      if (decodedFrames === null) return;

      for (const decoded of decodedFrames) {
        if (
          decoded._tag === "ResponseSuccess" ||
          decoded._tag === "ResponseError"
        ) {
          const id = decoded.id;
          const pending = yield* Ref.modify(this.pendingRef, (m) => {
            const entry = HashMap.get(m, id);
            return entry._tag === "Some"
              ? [entry.value, HashMap.remove(m, id)]
              : [null, m];
          });
          if (pending === null) continue;

          if (decoded._tag === "ResponseError") {
            const { error } = decoded;
            yield* Deferred.fail(
              pending,
              new RpcServerError({
                code:
                  typeof error.code === "number"
                    ? error.code
                    : JSON_RPC_INTERNAL_ERROR_CODE,
                message: error.message ?? MSG_RPC_ERROR_FALLBACK,
                data: error.data,
              }),
            );
          } else {
            yield* Deferred.succeed(pending, decoded.result);
          }
          continue;
        }

        if (decoded._tag === "ServerRequest") {
          // Task-callback request — non-blocking offer to the global
          // bounded queue (cutover #533). The drain fiber serializes
          // handler execution. If the queue is saturated, surface a
          // typed wire-level error so the server's `Deferred.await`
          // settles deterministically rather than hanging.
          const state = yield* Ref.get(this.stateRef);
          if (Option.isNone(state)) {
            // Reader fiber observed a frame without a corresponding
            // ConnState — only path here is a frame arriving between
            // scope-close finalization and reader-exit observation.
            // Drop silently: the queue + drain fiber are already gone.
            continue;
          }
          const offered = yield* Queue.offer(
            state.value.taskCallbackQueue,
            decoded,
          );
          if (!offered) {
            yield* this.writeQueueFullRejection(decoded.id, state.value.write);
          }
          continue;
        }

        if (decoded._tag === "Notification") {
          yield* this.subscribers.dispatch(decoded);
          const delivered = yield* Ref.modify(
            this.notificationWaitersRef,
            (m) => {
              const bucket = HashMap.get(m, decoded.definition);
              if (bucket._tag === "None" || bucket.value.length === 0) {
                return [null as NotificationWaiter | null, m];
              }
              const arr = bucket.value;
              const chosen = arr[arr.length - 1]!;
              const rest = arr.slice(0, -1);
              const nextMap =
                rest.length === 0
                  ? HashMap.remove(m, decoded.definition)
                  : HashMap.set(m, decoded.definition, rest);
              return [chosen, nextMap];
            },
          );
          if (delivered !== null) {
            yield* delivered.complete(decoded);
            continue;
          }

          yield* Ref.update(this.notificationsBufferRef, (xs) => {
            const appended = [...xs, decoded];
            return appended.length > MAX_EVENT_BUFFER
              ? appended.slice(-MAX_EVENT_BUFFER)
              : appended;
          });
        }
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

  private failAllPending(message: string): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const pending = yield* Ref.getAndSet(
        this.pendingRef,
        HashMap.empty<JsonRpcId, Deferred.Deferred<unknown, PendingError>>(),
      );
      for (const [, d] of HashMap.entries(pending)) {
        yield* Deferred.fail(d, new NotConnectedError({ message })).pipe(
          Effect.ignore,
        );
      }
    });
  }

  /** Schedule a reconnect attempt. Jittered exponential backoff (1s base,
   * 30s cap) routed through `Effect.sleep` so `TestClock` can drive it. */
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
