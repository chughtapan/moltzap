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
  Ref,
  Schedule,
  Scope,
} from "effect";
import {
  PROTOCOL_VERSION,
  Connect,
  decodeRpcResult,
  jsonRpcStringId,
  NotConnectedError,
  requestFrame,
  responseFrame,
  RpcServerError,
  RpcTimeoutError,
  type AnyAppCallbackRpcDefinition,
  type AnyNotificationDefinition,
  type JsonRpcStringId,
  type ParamsOf,
  type RequestFrame,
  type ResponseFrame,
  type ResultOf,
  type RpcDefinition,
  type TSchema,
  type Static,
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
import {
  makePartitionedDispatcher,
  type PartitionedDispatcher,
  type PartitionedDispatcherConfig,
} from "./internal/app-callback-partitioned-dispatcher.js";
import {
  PartitionLimitError,
  PartitionQueueFullError,
  type OfferRejected,
} from "./internal/app-callback-dispatcher-errors.js";

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

const MSG_NOT_CONNECTED = "WebSocket not connected";
const MSG_RPC_ERROR_FALLBACK = "RPC error";

const UTF8_DECODER = new TextDecoder("utf-8");

const makeNotConnectedError = (): NotConnectedError =>
  new NotConnectedError({ message: MSG_NOT_CONNECTED });

type ConnectResult = Static<typeof Connect.resultSchema>;

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
 * Spec #356: the single `Stream.runForEach`-driven `appCallbackInboundQueue` is
 * replaced by a `PartitionedDispatcher` keyed on
 * `(taskId, conversationId, hookKind)`. Each tuple owns one bounded
 * queue + one drain fiber; cross-tuple offers run concurrently. Held
 * here alongside its own `dispatcherScope` (NOT bound to the socket
 * scope) so `runSync(client.close())` can `runFork(Scope.close(…))`
 * without yielding through the runtime — the load-bearing regression
 * gate at `ws-client.test.ts:1233-1259`.
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
   * Per-connection partitioned appCallback dispatcher. Routes inbound appCallback
   * requests by `(taskId, conversationId, hookKind)`; replaces the
   * pre-#356 single drain fiber.
   */
  readonly dispatcher: PartitionedDispatcher;
  /**
   * Closeable Scope owning every per-partition worker + the idle
   * reaper. Off-Scope from the socket so `runSync(client.close())`
   * can `runFork(Scope.close(dispatcherScope, Exit.void))` without
   * yielding.
   */
  readonly dispatcherScope: Scope.CloseableScope;
}

/**
 * Internal type for a decoded inbound appCallback request handed off to the
 * dispatcher. Mirrors `DecodedServerRequest` from `runtime/frame.ts`
 * but lives here so the dispatcher does not need a `runtime/` import
 * cycle.
 */
interface DecodedServerRequest {
  readonly id: JsonRpcStringId;
  readonly definition: AnyAppCallbackRpcDefinition;
  readonly params: unknown;
}

/**
 * appCallback dispatcher knobs exposed on `MoltZapWsClientOptions`. All optional;
 * defaults from `DEFAULT_PARTITIONED_DISPATCHER_CONFIG`.
 *
 * Spec #356 OQ-3 (`idlePartitionTtlMs`) ships at the architect's
 * recommended default of 60_000 ms. Per OQ-5, 256 active partitions
 * comfortably absorbs current arena workloads (≤15 keys per session
 * at peak), so the cap doubles as a per-tenant DoS guard, not a
 * cardinality lever.
 */
export type AppCallbackDispatcherConfig = Partial<PartitionedDispatcherConfig>;

/**
 * Handler signature for `handleServerRpc`. The handler returns an
 * `Effect<unknown, RpcServerError>` — success values are encoded as the
 * response `result`; typed RPC errors are encoded as the response
 * `error`. Defects (handler crashes, non-tagged exceptions) collapse to a
 * generic InternalError reply.
 *
 * The `unknown`/`unknown` parameter and result types are transitional —
 * once Phase 1.1 (B.2) registers admission verbs in `appCallbackRpcMethods`, this
 * narrows generically against `AppCallbackRpcMap[M]`.
 */
export interface ServerRpcContext {
  readonly requestId: JsonRpcStringId;
  readonly definition: AnyAppCallbackRpcDefinition;
  readonly traceparent?: string;
}

export type ServerRpcHandler<
  D extends AnyAppCallbackRpcDefinition = AnyAppCallbackRpcDefinition,
> = (
  params: Static<D["paramsSchema"]>,
  ctx: ServerRpcContext & { readonly definition: D },
) => Effect.Effect<Static<D["resultSchema"]>, RpcServerError>;

type ErasedServerRpcHandler = (
  params: unknown,
  ctx: ServerRpcContext,
) => Effect.Effect<unknown, RpcServerError>;

interface NotificationWaiter {
  readonly definition: AnyNotificationDefinition;
  readonly complete: (notification: DecodedNotification) => Effect.Effect<void>;
  readonly fail: (error: Error) => Effect.Effect<void>;
}

type AnyDecodedNotification = DecodedNotification<AnyNotificationDefinition>;
type DecodedNotificationFor<D extends AnyNotificationDefinition> = Extract<
  AnyDecodedNotification,
  { readonly definition: D }
>;

function notificationMatches<D extends AnyNotificationDefinition>(
  definition: D,
  notification: AnyDecodedNotification,
): notification is DecodedNotificationFor<D> {
  return notification.definition === definition;
}

/**
 * Bridge an opaque wire-decoded notification to a typed
 * `waitForNotification` consumer. The wire decoder stays payload-opaque
 * (so `delivery/payload-opacity-client` conformance holds — see
 * `runtime/frame.ts`); this bridge is where drift turns into a visible
 * signal. A frame whose method matches `definition` but whose params
 * fail `definition.validateParams` is logged and skipped — the typed
 * promise never resolves with a malformed payload typed as if it were
 * valid. Existing "skip on non-match" semantics for the bucketed
 * waiter map are preserved; the only new behavior is the per-payload
 * validation guard.
 */
export function acceptTypedNotification<D extends AnyNotificationDefinition>(
  definition: D,
  notification: AnyDecodedNotification,
  logger: WsClientLogger | undefined,
): notification is DecodedNotificationFor<D> {
  if (!notificationMatches(definition, notification)) return false;
  if (!definition.validateParams(notification.params)) {
    logger?.warn(
      `waitForNotification: dropping ${definition.name} frame whose params failed schema validation (drift signal)`,
      notification.params,
    );
    return false;
  }
  return true;
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
  /**
   * Spec #356 — partitioned appCallback dispatcher knobs. Optional; omitted
   * fields fall back to `DEFAULT_PARTITIONED_DISPATCHER_CONFIG`.
   */
  appCallbackDispatcher?: AppCallbackDispatcherConfig;
}

/**
 * Return shape of `MoltZapWsClient.sendRpcTracked`. Surfaces the outbound
 * request `id` alongside the typed result without leaking the JSON-RPC wire
 * object onto the caller surface.
 */
export interface TrackedRpcResponse<R> {
  readonly id: JsonRpcStringId;
  readonly result: R;
}

/**
 * WebSocket lifecycle: open → auth/connect → active. On disconnect,
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
    HashMap.HashMap<JsonRpcStringId, Deferred.Deferred<unknown, PendingError>>
  >;
  private readonly stateRef: Ref.Ref<Option.Option<ConnState>>;
  private readonly malformedRef: Ref.Ref<number>;
  private readonly notificationsBufferRef: Ref.Ref<
    ReadonlyArray<DecodedNotification>
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
    HashMap.HashMap<AnyAppCallbackRpcDefinition, ErasedServerRpcHandler>
  >;

  private requestCounter = 0;
  private closed = false;
  private reconnectFiber: Fiber.RuntimeFiber<void, never> | null = null;
  private _helloOk: ConnectResult | null = null;

  constructor(private readonly options: MoltZapWsClientOptions) {
    this.runtime = ManagedRuntime.make(NodeSocket.layerWebSocketConstructor);
    this.pendingRef = this.runtime.runSync(
      Ref.make<
        HashMap.HashMap<
          JsonRpcStringId,
          Deferred.Deferred<unknown, PendingError>
        >
      >(HashMap.empty()),
    );
    this.stateRef = this.runtime.runSync(
      Ref.make<Option.Option<ConnState>>(Option.none()),
    );
    this.malformedRef = this.runtime.runSync(Ref.make(0));
    this.notificationsBufferRef = this.runtime.runSync(
      Ref.make<ReadonlyArray<DecodedNotification>>([]),
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
        HashMap.HashMap<AnyAppCallbackRpcDefinition, ErasedServerRpcHandler>
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
  handleServerRpc<D extends AnyAppCallbackRpcDefinition>(
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

  /** Open the socket, perform auth/connect, resolve with HelloOk. Fails
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
  sendRpc<D extends RpcDefinition<string, TSchema, TSchema>>(
    definition: D,
    params: ParamsOf<D>,
    opts?: RpcCallOptions,
  ): Effect.Effect<
    ResultOf<D>,
    NotConnectedError | RpcTimeoutError | RpcServerError
  > {
    return this.sendRpcEffect(definition, params, opts).pipe(
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
   * Send an RPC and surface the outbound request id alongside the
   * response envelope `type` and `result`. Spec #222 §5.1–5.2:
   * un-vacuates B4 (request-id tracking) and V5 (response-type
   * exposure). Mirrors `sendRpc`'s descriptor-backed call shape.
   *
   * Invariant 3 (spec #222 §4): the returned `id` is the same identity
   * minted inside the existing `rpc-${++counter}` site — no parallel
   * counter, no mirror. The single-id pre-condition is what makes B4 a
   * real check rather than a tautology.
   */
  sendRpcTracked<D extends RpcDefinition<string, TSchema, TSchema>>(
    definition: D,
    params: ParamsOf<D>,
  ): Effect.Effect<
    TrackedRpcResponse<ResultOf<D>>,
    NotConnectedError | RpcTimeoutError | RpcServerError
  > {
    return this.sendRpcTrackedEffect(definition, params).pipe(
      Effect.flatMap((tracked) =>
        definition.validateResult(tracked.result)
          ? Effect.succeed({ id: tracked.id, result: tracked.result })
          : Effect.fail(
              new RpcServerError({
                code: JSON_RPC_INTERNAL_ERROR_CODE,
                message: `Invalid result for method: ${definition.name}`,
                data: tracked.result,
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
        // The partitioned dispatcher's Scope is NOT bound to the
        // socket Scope (see ConnState doc): tear it down via runFork
        // so this Effect remains sync-runnable for callers using
        // `runSync(client.close())`. Closing the dispatcher Scope
        // cascades to every per-partition worker (queue.shutdown +
        // fiber interrupt via finalizers) and the idle reaper.
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
  ): Effect.Effect<DecodedNotificationFor<D>, Error> {
    return Effect.gen(this, function* () {
      const logger = this.options.logger;
      const buffered = yield* Ref.modify(
        this.notificationsBufferRef,
        (frames) => {
          for (const [idx, frame] of frames.entries()) {
            if (!acceptTypedNotification(definition, frame, logger)) continue;
            const next = [...frames.slice(0, idx), ...frames.slice(idx + 1)];
            return [frame, next];
          }
          return [null, frames];
        },
      );
      if (buffered !== null) return buffered;

      const deferred = yield* Deferred.make<DecodedNotificationFor<D>, Error>();
      const waiter: NotificationWaiter = {
        definition,
        complete: (notification) =>
          acceptTypedNotification(definition, notification, logger)
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

  /** Return all buffered notifications and clear the buffer. Synchronous. */
  drainNotifications(): DecodedNotification[] {
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
    // Tear down the partitioned dispatcher (off-scope, see ConnState
    // doc). runFork so disconnectSync stays synchronous for callers
    // using `runSync(client.disconnect())`. Closing the dispatcher
    // Scope cascades to every per-partition worker fiber + idle
    // reaper via Scope finalizers.
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

      // Settled first by whichever fires: the auth/connect response, or
      // reader-fiber exit on any close/error before handshake.
      const handshakeSettled = yield* Deferred.make<
        ConnectResult,
        PendingError
      >();

      // Spec #356 — partitioned appCallback dispatcher. Replaces the pre-#356
      // single `Stream.runForEach`-driven `appCallbackInboundQueue` with a
      // partition router keyed on `(taskId, conversationId,
      // hookKind)`. Each tuple owns one bounded queue + one drain
      // fiber; cross-tuple offers run on independent fibers, so a
      // parked `apps/onBeforeDispatch` cannot block the sibling
      // `apps/onBeforeMessageDelivery` whose response would resolve
      // the parking Deferred (arena#248 deadlock — fixed
      // structurally, not by timeout).
      //
      // Dispatcher Scope is allocated independently of the per-connect
      // socket Scope (`scope` above). Closing it cascades to every
      // per-partition worker via Scope finalizers; teardown from
      // `close()` / `disconnectSync()` is `runFork(Scope.close(…))`,
      // mirroring the reader-fiber ownership pattern (off-Scope so
      // `runSync(client.close())` doesn't yield through the runtime
      // — load-bearing regression gate at
      // `ws-client.test.ts:1233-1259`).
      const dispatcherScope = yield* Scope.make();
      const dispatcher = yield* makePartitionedDispatcher({
        handle: (req) =>
          this.dispatchInboundServerRequest(req as DecodedServerRequest, write),
        scope: dispatcherScope,
        ...(this.options.appCallbackDispatcher !== undefined
          ? { config: this.options.appCallbackDispatcher }
          : {}),
        ...(this.options.logger !== undefined
          ? { logger: this.options.logger }
          : {}),
      });

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
              // Tear down the partitioned dispatcher on socket-level
              // close (e.g. server-initiated). `close()` /
              // `disconnectSync()` already handle their own teardown for
              // client-initiated paths; this branch covers the case
              // where the server closes us. Forked so a slow handler
              // does not delay the rest of the disconnect path.
              // Idempotent with the explicit teardown in close().
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

      // Publish state BEFORE auth/connect: the write goes through
      // `sendRpcEffect`, which reads `stateRef`.
      yield* Ref.set(
        this.stateRef,
        Option.some({
          write,
          readerFiber,
          scope,
          handshakeSettled,
          dispatcher,
          dispatcherScope,
        }),
      );

      const authEffect = this.sendRpc(Connect, {
        agentKey: this.options.agentKey,
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
      });

      // Race the auth/connect response against the handshakeSettled deferred
      // `raceFirst` (not `race`) — `race` waits for the loser when the
      // winner fails, so a typed auth/connect error would hang behind the
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

  /**
   * Tracked variant of `sendRpcEffect`. Reuses the same Deferred /
   * pendingRef plumbing — the only difference is the resolved value:
   * `{id, result}` instead of bare `result`. This
   * keeps Invariant 3 (single id source) trivially: we mint `id` once
   * inside this body, register the Deferred under that id, and return
   * the same id to the caller alongside the result.
   */
  private sendRpcTrackedEffect<
    D extends RpcDefinition<string, TSchema, TSchema>,
  >(
    definition: D,
    params: ParamsOf<D>,
    opts?: RpcCallOptions,
  ): Effect.Effect<
    TrackedRpcResponse<ResultOf<D>>,
    NotConnectedError | RpcTimeoutError | RpcServerError
  > {
    return Effect.gen(this, function* () {
      const method = definition.name;
      const state = yield* Ref.get(this.stateRef);
      if (Option.isNone(state)) {
        return yield* Effect.fail(makeNotConnectedError());
      }

      const id = jsonRpcStringId(`rpc-${++this.requestCounter}`);
      const frame: RequestFrame = requestFrame(id, definition, params);

      // Register the Deferred BEFORE writing. `write` yields to the
      // scheduler; the reader could interleave, see a close, and
      // `failAllPending` before we register — leaving us to await a
      // never-resolved Deferred.
      const deferred = yield* Deferred.make<unknown, PendingError>();
      yield* Ref.update(this.pendingRef, (m) => HashMap.set(m, id, deferred));

      // `socket.writer` gates on an internal Latch that `runRaw` only
      // opens after the WebSocket hits OPEN. If the socket never
      // opens, `runRaw`'s `ensuring` closes the latch and `write`
      // blocks indefinitely — so we race the write against the
      // pending Deferred (which the reader fails on close),
      // short-circuiting the dead write.
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

      const timeoutMs = opts?.timeoutMs ?? RPC_TIMEOUT_MS;
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

      const decodedResult = yield* decodeRpcResult(definition, result).pipe(
        Effect.mapError(
          () =>
            new RpcServerError({
              code: JSON_RPC_INTERNAL_ERROR_CODE,
              message: `Invalid result for method: ${definition.name}`,
              data: result,
            }),
        ),
      );

      return { id, result: decodedResult };
    });
  }

  /**
   * Bare-result RPC — projects the tracked RPC envelope onto its
   * `result` field, discarding the `{id, type}` observability surface.
   * The write / race / timeout plumbing lives in `sendRpcTrackedEffect`
   * so there is one shared site for Invariant 3 (single id source),
   * Invariant 5 (typed error channel), and the `socket.writer` latch
   * race described below.
   */
  private sendRpcEffect<D extends RpcDefinition<string, TSchema, TSchema>>(
    definition: D,
    params: ParamsOf<D>,
    opts?: RpcCallOptions,
  ): Effect.Effect<
    ResultOf<D>,
    NotConnectedError | RpcTimeoutError | RpcServerError
  > {
    return this.sendRpcTrackedEffect(definition, params, opts).pipe(
      Effect.map((tracked) => tracked.result),
    );
  }

  /**
   * Translate a typed `OfferRejected` failure from the partitioned
   * dispatcher into a wire-level error response. Spec #356 §5: each
   * tag maps to a JSON-RPC error code so the server's
   * `Deferred.await` settles deterministically rather than hanging.
   *
   * Exhaustive over `OfferRejected`'s discriminated union: adding a
   * new tag fails the compile here.
   */
  private writeOfferRejection(
    err: OfferRejected,
    requestId: JsonRpcStringId,
    write: ConnState["write"],
  ): Effect.Effect<void, never> {
    const reply = this.offerRejectedResponse(err, requestId);
    return write(JSON.stringify(reply)).pipe(
      Effect.catchAll((werr) =>
        Effect.sync(() =>
          this.options.logger?.warn(
            "appCallback offer-rejection write failed",
            werr,
          ),
        ),
      ),
    );
  }

  private offerRejectedResponse(
    err: OfferRejected,
    requestId: JsonRpcStringId,
  ): ResponseFrame {
    if (err instanceof PartitionLimitError) {
      return responseFrame(requestId, {
        error: {
          code: -32000,
          message: `Server busy: partition limit reached (${err.activePartitions}/${err.maxPartitions})`,
        },
      });
    }
    if (err instanceof PartitionQueueFullError) {
      return responseFrame(requestId, {
        error: {
          code: -32000,
          message: `Server busy: partition queue full (capacity=${err.capacity})`,
        },
      });
    }
    const _exhaustive: never = err;
    return _exhaustive;
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
              responseFrame(request.id, {
                error: {
                  code: -32601,
                  message: "No handler registered for app callback descriptor",
                },
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
                    responseFrame(request.id, {
                      result,
                    }) satisfies ResponseFrame,
                  onFailure: (err) =>
                    responseFrame(request.id, {
                      error: {
                        code: err.code,
                        message: err.message,
                        ...(err.data !== undefined ? { data: err.data } : {}),
                      },
                    }) satisfies ResponseFrame,
                }),
                Effect.catchAllCause((cause) =>
                  Effect.sync(() => {
                    this.options.logger?.warn(
                      "appCallback handler defected",
                      Cause.pretty(cause),
                    );
                    return responseFrame(request.id, {
                      error: { code: -32603, message: "Internal error" },
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
        if (decoded._tag === "Response") {
          const { id, result, error } = decoded;
          const pending = yield* Ref.modify(this.pendingRef, (m) => {
            const entry = HashMap.get(m, id);
            return entry._tag === "Some"
              ? [entry.value, HashMap.remove(m, id)]
              : [null, m];
          });
          if (pending === null) continue;

          if (error) {
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
            yield* Deferred.succeed(pending, result);
          }
          continue;
        }

        if (decoded._tag === "ServerRequest") {
          // appCallback request — hand off to the partitioned dispatcher
          // (spec #356). The dispatcher routes by
          // `(taskId, conversationId, hookKind)`; the matching
          // per-tuple worker fiber drains and runs
          // `dispatchInboundServerRequest`, which writes the reply
          // back. Cross-tuple offers run concurrently — the arena#248
          // deadlock between parked `apps/onBeforeDispatch` and
          // sibling `apps/onBeforeMessageDelivery` cannot recur.
          //
          // `dispatcher.offer` is non-blocking: every failure mode is
          // tagged in `OfferRejected` and translated below to a wire
          // error response so the server's `Deferred.await` always
          // settles (no hangs on partition-full requests).
          const state = yield* Ref.get(this.stateRef);
          if (Option.isNone(state)) {
            // Reader fiber observed a frame without a corresponding
            // ConnState — the only path that reaches here is a frame
            // arriving between scope-close finalization and reader-exit
            // observation. Drop silently: the dispatcher is already
            // gone too.
            continue;
          }
          const offered = yield* Effect.either(
            state.value.dispatcher.offer(decoded),
          );
          const offerFailure = Either.match(offered, {
            onLeft: (err) => err,
            onRight: () => null,
          });
          if (offerFailure !== null) {
            yield* this.writeOfferRejection(
              offerFailure,
              decoded.id,
              state.value.write,
            );
          }
          continue;
        }

        if (decoded._tag === "Notification") {
          // Spec #222 §5.3 (C4 + subscribe-stub): per-subscription
          // fan-out replaces the deleted top-level `onNotification` callback.
          // Snapshot-at-dispatch semantics live inside the registry
          // (OQ-3 A); see runtime/subscribers.ts.
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
        HashMap.empty<
          JsonRpcStringId,
          Deferred.Deferred<unknown, PendingError>
        >(),
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
      // Collapse typed errors so `Schedule.exponential` can retry.
      Effect.mapError(
        () =>
          new ReconnectAttemptFailedError({
            reason: "reconnect attempt failed",
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
