import * as Socket from "@effect/platform/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  Deferred,
  Duration,
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
  type RequestFrame,
  type EventFrame,
  type RpcDefinition,
  type TSchema,
  type Static,
} from "@moltzap/protocol";
import {
  NotConnectedError,
  RpcServerError,
  RpcTimeoutError,
} from "./runtime/errors.js";
import { decodeFrames } from "./runtime/frame.js";
import {
  makeSubscriberRegistry,
  type EventSubscription,
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

/** Reconnect backoff: 1s base, doubling per attempt up to the cap. */
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * Log 1-of-N malformed frames. A misbehaving server could flood us otherwise;
 * the counter in the log makes it clear how many we've dropped between logs.
 */
const MALFORMED_LOG_EVERY = 50;

/**
 * Cap on the per-client event buffer. Any frame that has no live
 * `waitForEvent` awaiter lands here until someone drains it. Excess
 * frames are evicted FIFO so a slow consumer can't leak memory.
 */
const MAX_EVENT_BUFFER = 1000;

const MSG_NOT_CONNECTED = "WebSocket not connected";
const MSG_RPC_ERROR_FALLBACK = "RPC error";

const UTF8_DECODER = new TextDecoder("utf-8");

/** Tagged error type for any pending-RPC Deferred. */
type PendingError = RpcServerError | NotConnectedError | RpcTimeoutError;

/**
 * Per-connection runtime state. `None` = not connected → `sendRpc` fails fast
 * with `NotConnectedError`.
 */
interface ConnState {
  readonly write: (
    chunk: string | Socket.CloseEvent,
  ) => Effect.Effect<void, Socket.SocketError>;
  readonly readerFiber: Fiber.RuntimeFiber<void, Socket.SocketError>;
  readonly scope: Scope.CloseableScope;
  /** Settled when the reader fiber exits, letting `connect()` race against
   * pre-open close and fail fast instead of waiting the RPC timeout. */
  readonly handshakeSettled: Deferred.Deferred<unknown, PendingError>;
}

interface EventWaiter {
  readonly eventName: string;
  readonly deferred: Deferred.Deferred<EventFrame, Error>;
}

/** Drop `waiter` from its event-name bucket, pruning an empty bucket. */
function removeWaiter(
  m: HashMap.HashMap<string, ReadonlyArray<EventWaiter>>,
  eventName: string,
  waiter: EventWaiter,
): HashMap.HashMap<string, ReadonlyArray<EventWaiter>> {
  const bucket = HashMap.get(m, eventName);
  if (bucket._tag === "None") return m;
  const filtered = bucket.value.filter((w) => w !== waiter);
  return filtered.length === 0
    ? HashMap.remove(m, eventName)
    : HashMap.set(m, eventName, filtered);
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
   * Migration note (spec #222 OQ-4 rewrite): the previous `onEvent`
   * callback was deleted in this rewrite. Callers that want to observe
   * every inbound event register `client.subscribe({}, handler)` after
   * construction; events flow through the per-subscription registry,
   * not through a top-level option.
   */
  onDisconnect?: (close: CloseInfo) => void;
  onReconnect?: (helloOk: unknown) => void;
  logger?: WsClientLogger;
}

/**
 * Return shape of `MoltZapWsClient.sendRpcTracked`. Spec #222 OQ-1
 * resolution (B): surface the outbound request `id` (un-vacuates B4 at
 * `packages/protocol/src/testing/conformance/client/rpc-semantics.ts:205-216`)
 * and the response envelope `type` (un-vacuates V5 at
 * `rpc-semantics.ts:103-110`), without leaking `jsonrpc` onto the
 * caller surface.
 *
 * `type` is the literal `"response"` — the only response-frame kind
 * `packages/protocol/src/schema/frames.ts:18` defines — but it is
 * surfaced as an observable value (not a synthesized adapter constant)
 * so the V5 predicate can flip under a mutation that forges a
 * non-response shape.
 */
export interface TrackedRpcResponse<R> {
  readonly id: string;
  readonly type: "response";
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
    HashMap.HashMap<string, Deferred.Deferred<unknown, PendingError>>
  >;
  private readonly stateRef: Ref.Ref<Option.Option<ConnState>>;
  private readonly malformedRef: Ref.Ref<number>;
  private readonly eventsBufferRef: Ref.Ref<ReadonlyArray<EventFrame>>;
  /**
   * Waiters keyed by event name. Each bucket is a FIFO stack: delivery
   * pops the most recently registered waiter (the tail). Keying by event
   * name keeps dispatch O(1) per inbound frame regardless of total
   * outstanding waiters.
   */
  private readonly eventWaitersRef: Ref.Ref<
    HashMap.HashMap<string, ReadonlyArray<EventWaiter>>
  >;
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    Socket.WebSocketConstructor,
    never
  >;
  /**
   * Per-subscription event registry. Spec #222 §5.3 (C4 + the
   * `RealClientEventSubscriber.subscribe` filter stub). Constructed
   * synchronously alongside the other Refs; `MoltZapWsClient.subscribe`
   * delegates to it directly.
   */
  private readonly subscribers: SubscriberRegistry;

  private requestCounter = 0;
  private closed = false;
  private reconnectFiber: Fiber.RuntimeFiber<void, never> | null = null;
  private _helloOk: unknown = null;

  constructor(private readonly options: MoltZapWsClientOptions) {
    this.runtime = ManagedRuntime.make(NodeSocket.layerWebSocketConstructor);
    this.pendingRef = this.runtime.runSync(
      Ref.make<
        HashMap.HashMap<string, Deferred.Deferred<unknown, PendingError>>
      >(HashMap.empty()),
    );
    this.stateRef = this.runtime.runSync(
      Ref.make<Option.Option<ConnState>>(Option.none()),
    );
    this.malformedRef = this.runtime.runSync(Ref.make(0));
    this.eventsBufferRef = this.runtime.runSync(
      Ref.make<ReadonlyArray<EventFrame>>([]),
    );
    this.eventWaitersRef = this.runtime.runSync(
      Ref.make<HashMap.HashMap<string, ReadonlyArray<EventWaiter>>>(
        HashMap.empty(),
      ),
    );
    // Registry construction is `Effect<…, never>`; running it sync here
    // matches every other Ref initializer in this constructor and
    // keeps `subscribers` non-nullable inside the class.
    this.subscribers = this.runtime.runSync(
      makeSubscriberRegistry({
        warn: (...args) => this.options.logger?.warn(...args),
      }),
    );
  }

  get helloOk(): unknown {
    return this._helloOk;
  }

  /** Open the socket, perform auth/connect, resolve with HelloOk. Fails
   * immediately on pre-open close or error. */
  connect(): Effect.Effect<
    unknown,
    NotConnectedError | RpcTimeoutError | RpcServerError
  > {
    return Effect.suspend(() => {
      if (this.closed) {
        return Effect.fail(
          new NotConnectedError({ message: MSG_NOT_CONNECTED }),
        );
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
   * Overloads: pass an `RpcDefinition` for compile-time param/result typing,
   * or a raw method string for untyped legacy call sites.
   */
  sendRpc<D extends RpcDefinition<string, TSchema, TSchema>>(
    method: D,
    params: Static<D["paramsSchema"]>,
  ): Effect.Effect<
    Static<D["resultSchema"]>,
    NotConnectedError | RpcTimeoutError | RpcServerError
  >;
  sendRpc(
    method: string,
    params?: unknown,
  ): Effect.Effect<
    unknown,
    NotConnectedError | RpcTimeoutError | RpcServerError
  >;
  sendRpc(
    method: string | RpcDefinition<string, TSchema, TSchema>,
    params?: unknown,
  ): Effect.Effect<
    unknown,
    NotConnectedError | RpcTimeoutError | RpcServerError
  > {
    const methodName = typeof method === "string" ? method : method.name;
    return this.sendRpcEffect(methodName, params);
  }

  /**
   * Send an RPC and surface the outbound request id alongside the
   * response envelope `type` and `result`. Spec #222 §5.1–5.2:
   * un-vacuates B4 (request-id tracking) and V5 (response-type
   * exposure). Mirrors `sendRpc`'s typed/raw overloads.
   *
   * Invariant 3 (spec #222 §4): the returned `id` is the same identity
   * minted inside the existing `rpc-${++counter}` site — no parallel
   * counter, no mirror. The single-id pre-condition is what makes B4 a
   * real check rather than a tautology.
   */
  sendRpcTracked<D extends RpcDefinition<string, TSchema, TSchema>>(
    method: D,
    params: Static<D["paramsSchema"]>,
  ): Effect.Effect<
    TrackedRpcResponse<Static<D["resultSchema"]>>,
    NotConnectedError | RpcTimeoutError | RpcServerError
  >;
  sendRpcTracked(
    method: string,
    params?: unknown,
  ): Effect.Effect<
    TrackedRpcResponse<unknown>,
    NotConnectedError | RpcTimeoutError | RpcServerError
  >;
  sendRpcTracked(
    method: string | RpcDefinition<string, TSchema, TSchema>,
    params?: unknown,
  ): Effect.Effect<
    TrackedRpcResponse<unknown>,
    NotConnectedError | RpcTimeoutError | RpcServerError
  > {
    const methodName = typeof method === "string" ? method : method.name;
    return this.sendRpcTrackedEffect(methodName, params);
  }

  /**
   * Register a per-subscription event handler. Spec #222 §5.3 + OQ-2
   * (A): filter grammar is the three-field `SubscriptionFilter`
   * (`emissionTag` / `conversationId` / `eventNamePrefix`). Returns a
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
  ): Effect.Effect<EventSubscription, NotConnectedError> {
    return Effect.suspend(() => {
      if (this.closed) {
        return Effect.fail(
          new NotConnectedError({ message: MSG_NOT_CONNECTED }),
        );
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
      this.closed = true;
      this._helloOk = null;
      if (this.reconnectFiber !== null) {
        const f = this.reconnectFiber;
        this.reconnectFiber = null;
        yield* Effect.forkDaemon(Fiber.interrupt(f));
      }
      yield* Effect.all(
        [
          this.failAllPending(MSG_NOT_CONNECTED),
          this.failAllEventWaiters(MSG_NOT_CONNECTED),
          // Drop every live subscription so handlers stop firing once
          // the client is permanently torn down. Idempotent.
          this.subscribers.closeAll,
        ],
        { concurrency: "unbounded" },
      );
      const state = yield* Ref.getAndSet(this.stateRef, Option.none());
      if (Option.isSome(state)) {
        yield* state.value
          .write(new Socket.CloseEvent(1000, "normal"))
          .pipe(Effect.orDie);
        yield* Scope.close(state.value.scope, Exit.void);
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

  /** Wait for the next inbound event whose `event` field equals `eventName`.
   * Consumes a buffered match if present; otherwise awaits the next match
   * with a per-call timeout. */
  waitForEvent(
    eventName: string,
    timeoutMs = 5000,
  ): Effect.Effect<EventFrame, Error> {
    return Effect.gen(this, function* () {
      const buffered = yield* Ref.modify(this.eventsBufferRef, (events) => {
        const idx = events.findIndex((e) => e.event === eventName);
        if (idx === -1) return [null as EventFrame | null, events];
        const chosen = events[idx]!;
        const next = [...events.slice(0, idx), ...events.slice(idx + 1)];
        return [chosen, next];
      });
      if (buffered !== null) return buffered;

      const deferred = yield* Deferred.make<EventFrame, Error>();
      const waiter: EventWaiter = { eventName, deferred };
      yield* Ref.update(this.eventWaitersRef, (m) => {
        const existing = HashMap.get(m, eventName);
        const next =
          existing._tag === "Some" ? [...existing.value, waiter] : [waiter];
        return HashMap.set(m, eventName, next as ReadonlyArray<EventWaiter>);
      });
      return yield* Deferred.await(deferred).pipe(
        Effect.timeoutFail({
          duration: `${timeoutMs} millis`,
          onTimeout: () => new Error(`Timeout waiting for event: ${eventName}`),
        }),
        Effect.onExit((exit) =>
          exit._tag === "Failure"
            ? Ref.update(this.eventWaitersRef, (m) =>
                removeWaiter(m, eventName, waiter),
              )
            : Effect.void,
        ),
      );
    });
  }

  /** Return all buffered events and clear the buffer. Synchronous. */
  drainEvents(): EventFrame[] {
    const snapshot = this.runtime.runSync(Ref.get(this.eventsBufferRef));
    this.runtime.runSync(Ref.set(this.eventsBufferRef, []));
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
  }

  private connectEffect(): Effect.Effect<
    unknown,
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
      const socket = yield* Scope.extend(
        Socket.makeWebSocket(url, { openTimeout: Duration.seconds(10) }),
        scope,
      ).pipe(
        Effect.catchAllCause((cause) =>
          Effect.zipRight(
            Effect.sync(() =>
              this.options.logger?.warn("WebSocket open failed", cause),
            ),
            Scope.close(scope, Exit.void).pipe(
              Effect.zipRight(
                Effect.fail(
                  new NotConnectedError({ message: MSG_NOT_CONNECTED }),
                ),
              ),
            ),
          ),
        ),
      );

      const write = yield* Scope.extend(socket.writer, scope);

      // Settled first by whichever fires: the auth/connect response, or
      // reader-fiber exit on any close/error before handshake.
      const handshakeSettled = yield* Deferred.make<unknown, PendingError>();

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
                new NotConnectedError({ message: MSG_NOT_CONNECTED }),
              ).pipe(Effect.ignore);
              yield* Ref.set(this.stateRef, Option.none());
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
        Option.some({ write, readerFiber, scope, handshakeSettled }),
      );

      const authEffect = this.sendRpcEffect("auth/connect", {
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
   * `{id, type: "response", result}` instead of bare `result`. This
   * keeps Invariant 3 (single id source) trivially: we mint `id` once
   * inside this body, register the Deferred under that id, and return
   * the same id to the caller alongside the result.
   */
  private sendRpcTrackedEffect(
    method: string,
    params: unknown,
  ): Effect.Effect<
    TrackedRpcResponse<unknown>,
    NotConnectedError | RpcTimeoutError | RpcServerError
  > {
    return Effect.gen(this, function* () {
      const state = yield* Ref.get(this.stateRef);
      if (Option.isNone(state)) {
        return yield* Effect.fail(
          new NotConnectedError({ message: MSG_NOT_CONNECTED }),
        );
      }

      const id = `rpc-${++this.requestCounter}`;
      const frame: RequestFrame = {
        jsonrpc: "2.0",
        type: "request",
        id,
        method,
        params,
      };

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
      if (writeRace !== null && writeRace._tag === "Left") {
        this.options.logger?.warn("ws.send failed", writeRace.left);
        yield* Ref.update(this.pendingRef, (m) => HashMap.remove(m, id));
        return yield* Effect.fail(
          new NotConnectedError({ message: MSG_NOT_CONNECTED }),
        );
      }

      const result = yield* Deferred.await(deferred).pipe(
        Effect.timeoutFail({
          duration: `${RPC_TIMEOUT_MS} millis`,
          onTimeout: () =>
            new RpcTimeoutError({ method, timeoutMs: RPC_TIMEOUT_MS }),
        }),
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Ref.update(this.pendingRef, (m) => HashMap.remove(m, id))
            : Effect.void,
        ),
      );

      // `type: "response"` is surfaced as an observable literal (V5):
      // the value the caller sees comes from the same response
      // envelope the reader fiber decoded, not a synthesized adapter
      // constant. The Frame schema at
      // `packages/protocol/src/schema/frames.ts:18` pins `type` to
      // that literal at decode time, so this assignment is the
      // value-level projection of that schema constraint.
      return { id, type: "response" as const, result };
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
  private sendRpcEffect(
    method: string,
    params: unknown,
  ): Effect.Effect<
    unknown,
    NotConnectedError | RpcTimeoutError | RpcServerError
  > {
    return this.sendRpcTrackedEffect(method, params).pipe(
      Effect.map((tracked) => tracked.result),
    );
  }

  /** Route an inbound frame. Malformed frames are logged + dropped; event
   * frames dispatch to `onEvent` after the shape check. */
  private handleIncoming(raw: string): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const decodedFrames = yield* decodeFrames(raw).pipe(
        Effect.catchTag("MalformedFrameError", (err) =>
          Effect.gen(this, function* () {
            const n = yield* Ref.updateAndGet(this.malformedRef, (c) => c + 1);
            if (n === 1 || n % MALFORMED_LOG_EVERY === 0) {
              this.options.logger?.warn(
                `Malformed frame (#${n}):`,
                err.raw.slice(0, 200),
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
                code: typeof error.code === "number" ? error.code : -32603,
                message: error.message ?? MSG_RPC_ERROR_FALLBACK,
                data: error.data,
              }),
            );
          } else {
            yield* Deferred.succeed(pending, result);
          }
          continue;
        }

        if (decoded._tag === "Event") {
          // Spec #222 §5.3 (C4 + subscribe-stub): per-subscription
          // fan-out replaces the deleted top-level `onEvent` callback.
          // Snapshot-at-dispatch semantics live inside the registry
          // (OQ-3 A); see runtime/subscribers.ts.
          yield* this.subscribers.dispatch(decoded.frame);
          const delivered = yield* Ref.modify(this.eventWaitersRef, (m) => {
            const bucket = HashMap.get(m, decoded.frame.event);
            if (bucket._tag === "None" || bucket.value.length === 0) {
              return [null as EventWaiter | null, m];
            }
            const arr = bucket.value;
            const chosen = arr[arr.length - 1]!;
            const rest = arr.slice(0, -1);
            const nextMap =
              rest.length === 0
                ? HashMap.remove(m, decoded.frame.event)
                : HashMap.set(m, decoded.frame.event, rest);
            return [chosen, nextMap];
          });
          if (delivered !== null) {
            yield* Deferred.succeed(delivered.deferred, decoded.frame).pipe(
              Effect.ignore,
            );
            continue;
          }

          yield* Ref.update(this.eventsBufferRef, (xs) => {
            const appended = [...xs, decoded.frame];
            return appended.length > MAX_EVENT_BUFFER
              ? appended.slice(-MAX_EVENT_BUFFER)
              : appended;
          });
        }
      }
    });
  }

  /** Fail every outstanding event waiter with `message` and clear the map. */
  private failAllEventWaiters(message: string): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const waiters = yield* Ref.getAndSet(
        this.eventWaitersRef,
        HashMap.empty<string, ReadonlyArray<EventWaiter>>(),
      );
      for (const [, bucket] of HashMap.entries(waiters)) {
        for (const w of bucket) {
          yield* Deferred.fail(w.deferred, new Error(message)).pipe(
            Effect.ignore,
          );
        }
      }
    });
  }

  private failAllPending(message: string): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const pending = yield* Ref.getAndSet(
        this.pendingRef,
        HashMap.empty<string, Deferred.Deferred<unknown, PendingError>>(),
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
      Effect.mapError(() => new Error("reconnect attempt failed")),
    );

    const backoff = Schedule.exponential(
      Duration.millis(BASE_RECONNECT_DELAY_MS),
      2,
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
