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
import { decodeFrame } from "./runtime/frame.js";

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

const MSG_NOT_CONNECTED = "WebSocket not connected";
const MSG_RPC_ERROR_FALLBACK = "RPC error";

/** Tagged error type for any pending-RPC Deferred. */
type PendingError = RpcServerError | NotConnectedError | RpcTimeoutError;

/**
 * Per-connection runtime state. Present only while the reader fiber owns the
 * socket. `None` = not connected => `sendRpc` fails fast with
 * `NotConnectedError` (replaces the `ws.readyState !== OPEN` check —
 * gotcha §4.2 in the scoping doc).
 */
interface ConnState {
  readonly write: (frame: string) => Effect.Effect<void, Socket.SocketError>;
  readonly readerFiber: Fiber.RuntimeFiber<void, Socket.SocketError>;
  readonly scope: Scope.CloseableScope;
  /** Settled when the reader fiber exits — lets connect() race against
   * pre-open close (§5.1) and fail fast instead of waiting the RPC timeout. */
  readonly handshakeSettled: Deferred.Deferred<unknown, PendingError>;
}

export interface WsClientLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

export interface MoltZapWsClientOptions {
  serverUrl: string;
  agentKey: string;
  onEvent: (event: EventFrame) => void;
  onDisconnect: () => void;
  onReconnect: (helloOk: unknown) => void;
  logger?: WsClientLogger;
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
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    Socket.WebSocketConstructor,
    never
  >;

  private requestCounter = 0;
  private closed = false;
  private reconnectFiber: Fiber.RuntimeFiber<void, never> | null = null;
  private _helloOk: unknown = null;

  constructor(private readonly options: MoltZapWsClientOptions) {
    // Provide the Node WebSocketConstructor so the `makeWebSocket` Effect can
    // run inside this client's runtime without bubbling the requirement out.
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
  }

  get helloOk(): unknown {
    return this._helloOk;
  }

  /**
   * Open the socket, perform auth/connect, resolve with HelloOk.
   * Fails immediately on pre-open close or error (§5.1).
   */
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
   *   - `NotConnectedError` if the socket isn't OPEN or closes while the RPC
   *     is pending (§5.2)
   *   - `RpcTimeoutError` after `RPC_TIMEOUT_MS` — no automatic retry (§5.3)
   *   - `RpcServerError` on a typed server-error frame
   *
   * Two overloads:
   *   - Typed manifest: `sendRpc(AgentsLookupByName, { names: [...] })` — params
   *     and return type are checked against the `RpcDefinition` at compile time.
   *   - Legacy string: `sendRpc("agents/lookupByName", {...})` — kept for
   *     back-compat during transition. Untyped; use the manifest form for
   *     new code.
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
   * Close the socket permanently (no reconnection). The internal cleanup uses
   * Effect but is wrapped here in `Effect.sync` so callers receive an Effect
   * that never fails.
   */
  close(): Effect.Effect<void, never> {
    return Effect.sync(() => this.closeSync());
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

  /**
   * Internal synchronous close: invoked from the public `close()` Effect.
   * Side-effectful. Runs cleanup under the client's runtime then disposes it.
   */
  private closeSync(): void {
    if (this.closed) return;
    this.closed = true;
    this._helloOk = null;
    // Interrupt any in-flight reconnect scheduling.
    if (this.reconnectFiber !== null) {
      this.runtime.runFork(Fiber.interrupt(this.reconnectFiber));
      this.reconnectFiber = null;
    }
    // Fail pending Deferreds synchronously — no race with dispose().
    this.runtime.runSync(this.failAllPending(MSG_NOT_CONNECTED));
    const state = this.runtime.runSync(Ref.get(this.stateRef));
    this.runtime.runSync(Ref.set(this.stateRef, Option.none()));
    if (Option.isSome(state)) {
      // Close the connection's scope synchronously inside the runtime so the
      // reader fiber is torn down before we dispose.
      this.runtime.runSync(Scope.close(state.value.scope, Exit.void));
    }
    void this.runtime.dispose();
  }

  private connectEffect(): Effect.Effect<
    unknown,
    NotConnectedError | RpcTimeoutError | RpcServerError,
    Socket.WebSocketConstructor
  > {
    return Effect.gen(this, function* () {
      const url = this.options.serverUrl.replace(/^http/, "ws") + "/ws";

      // Fresh scope per connect attempt. Closing it tears down the reader
      // fiber + the underlying WebSocket (gotcha §2d/§4 — scope replaces
      // `ws.close()`). Held by the client (not the caller's fiber) so the
      // reader fiber + writer outlive the outer `connect()` Effect.
      const scope = yield* Scope.make();

      // Acquire the Socket inside the per-connection scope. If the WS fails
      // to open, `Socket.makeWebSocket` fails with SocketGenericError / a
      // SocketCloseError — we map to NotConnectedError (§5.1).
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

      // Resolve the scope-owned writer. Closes on scope close.
      const write = yield* Scope.extend(socket.writer, scope);

      // Settled by whichever happens first: auth/connect response,
      // or reader fiber exit (clean/unclean close, error). §5.1 latch.
      const handshakeSettled = yield* Deferred.make<unknown, PendingError>();

      // Reader Effect. `runRaw` dispatches every inbound frame through
      // `handleIncoming`. Use `onExit` (not `tapErrorCause`) so the
      // clean-close path (code 1000 — defaultCloseCodeIsError = false) also
      // triggers pending-drain; without this, §5.2 hangs on clean close
      // (gotcha §4.10).
      const readerEffect = socket
        .runRaw((data) =>
          this.handleIncoming(
            typeof data === "string"
              ? data
              : new TextDecoder("utf-8").decode(data),
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
              // If connect() is still awaiting the handshake, settle it
              // with NotConnectedError so §5.1 does not hang.
              yield* Deferred.fail(
                handshakeSettled,
                new NotConnectedError({ message: MSG_NOT_CONNECTED }),
              ).pipe(Effect.ignore);
              yield* Ref.set(this.stateRef, Option.none());
              // Notify the host callback — logs are its concern.
              yield* Effect.sync(() => {
                try {
                  this.options.onDisconnect();
                } catch (err) {
                  this.options.logger?.warn("onDisconnect handler threw", err);
                }
              });
              // Start a reconnect loop if we still want to be connected.
              if (!this.closed) {
                this.scheduleReconnect();
              }
            }),
          ),
        );

      // Fork the reader on the CLIENT's long-lived runtime — NOT the caller's
      // fiber — so it outlives the outer `connect()` Effect. Otherwise, when
      // `Effect.runPromise(connect())` returns, the caller's fiber tree
      // finalizes and the reader fiber gets interrupted, triggering `onExit`
      // which clears `_helloOk`.
      const readerFiber = this.runtime.runFork(readerEffect);

      // Publish state BEFORE sending auth/connect — the outbound write goes
      // through `sendRpcEffect`, which reads `stateRef`.
      yield* Ref.set(
        this.stateRef,
        Option.some({ write, readerFiber, scope, handshakeSettled }),
      );

      // Kick off auth/connect. Its Deferred lives in `pendingRef` so the
      // reader fiber can resolve it (same mechanism as any other RPC).
      const authEffect = this.sendRpcEffect("auth/connect", {
        agentKey: this.options.agentKey,
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
      });

      // Race the auth/connect response against the handshakeSettled deferred
      // — whichever fires first (handshake success | pre-response close/error)
      // settles the outer connect. `Effect.race` interrupts the loser.
      const result = yield* Effect.race(
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

  private sendRpcEffect(
    method: string,
    params: unknown,
  ): Effect.Effect<
    unknown,
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

      // Register the Deferred BEFORE writing (gotcha §4.9). `write(...)` is
      // an Effect that may yield; the reader fiber can interleave, see a
      // close, and run `failAllPending` before we register. Register-first
      // closes that race.
      const deferred = yield* Deferred.make<unknown, PendingError>();
      yield* Ref.update(this.pendingRef, (m) => HashMap.set(m, id, deferred));

      // `state.value.write` gates on an internal Latch that `runRaw` only
      // opens after the WebSocket hits `OPEN`. If the socket never opens
      // (connection refused, server immediate close), `runRaw`'s `ensuring`
      // closes the latch — `write` then blocks indefinitely.
      //
      // Race the write against the pending Deferred (which the reader fiber
      // fails via `failAllPending` when the socket closes). Either:
      //   - The write completes (sent on the wire). Continue to Deferred.await.
      //   - The Deferred resolves/fails first (e.g. pre-open close). Short
      //     circuit without waiting on the dead write.
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

      return yield* Deferred.await(deferred).pipe(
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
    });
  }

  /**
   * Route an inbound frame. Malformed frames are logged (with truncated
   * payload) and dropped — they never resolve a Deferred and never crash
   * the connection (§5.4). Event frames dispatch to `onEvent` only after
   * passing the shape check.
   */
  private handleIncoming(raw: string): Effect.Effect<void> {
    return Effect.gen(this, function* () {
      const decoded = yield* decodeFrame(raw).pipe(
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
      if (decoded === null) return;

      if (decoded._tag === "Response") {
        const { id, result, error } = decoded;
        const pending = yield* Ref.modify(this.pendingRef, (m) => {
          const entry = HashMap.get(m, id);
          return entry._tag === "Some"
            ? [entry.value, HashMap.remove(m, id)]
            : [null, m];
        });
        if (pending === null) return;

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
        return;
      }

      if (decoded._tag === "Event") {
        try {
          this.options.onEvent(decoded.frame);
        } catch (err) {
          this.options.logger?.error("onEvent handler threw", err);
        }
      }
    });
  }

  /** Fail every outstanding RPC with NotConnectedError and clear the map. */
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

  /**
   * Schedule a reconnect attempt. Exponential base (1s) doubling to a 30s
   * cap, jittered 0.5–1.0× via `Schedule.jittered` — observably similar to
   * the previous hand-rolled `baseDelay * (0.5 + Math.random() * 0.5)`, and
   * routed through `Effect.sleep` so TestClock can drive it (a latent win
   * vs the old raw `setTimeout`).
   *
   * Decision §8.2: chose stock `Schedule.jittered` over hand-rolled to match
   * the current jitter distribution exactly. Both are observably similar
   * (both sample uniformly inside ~half the base delay) and stock keeps the
   * code small + keeps the scoping-doc footnote honest.
   */
  private scheduleReconnect(): void {
    if (this.closed || this.reconnectFiber !== null) return;

    const attempt = this.connectEffect().pipe(
      Effect.tap((helloOk) =>
        Effect.sync(() => {
          try {
            this.options.onReconnect(helloOk);
          } catch (err) {
            this.options.logger?.warn("onReconnect handler threw", err);
          }
        }),
      ),
      // Collapse typed errors to a failure that `Schedule.exponential` can retry.
      Effect.mapError(() => new Error("reconnect attempt failed")),
    );

    // Schedule.exponential(1s, 2) * jittered, capped at 30s via `Schedule.either`
    // with `Schedule.spaced(30s)`.
    const backoff = Schedule.exponential(
      Duration.millis(BASE_RECONNECT_DELAY_MS),
      2,
    ).pipe(
      Schedule.either(Schedule.spaced(Duration.millis(MAX_RECONNECT_DELAY_MS))),
      Schedule.jittered,
    );

    // One-shot retry loop. Give up silently if the client is closed during
    // a retry — the closed flag is checked on each attempt via `connectEffect`
    // via the public `connect()` path; here we short-circuit.
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
