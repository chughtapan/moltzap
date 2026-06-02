/**
 * Shared reconnecting-socket-client primitives.
 *
 * `MoltZapAppClient` (`app-client.ts`) and `MoltZapAgentClient`
 * (`agent-client.ts`) are ~90% identical reconnecting WebSocket clients:
 * both open a `Socket.makeWebSocket` under a request `Scope`, fork a
 * reader fiber, and on reader-exit run an exponential-backoff reconnect
 * loop. This module factors out the pieces that are byte-identical
 * across both clients and carry NO per-client receiver state — the
 * reconnect-tuning constants, the malformed-frame log gate, the
 * not-connected error mint, the `ReconnectAttemptFailedError` the
 * reconnect loop fails with, the backoff `Schedule`, the wire URL
 * derivation, and the scope-bound socket open. The per-client pieces
 * (the dispatcher queue, the originator wiring, the handshake race) stay
 * in each client; this is the transport-plumbing base they share.
 *
 * Pure: no Refs, no fibers held here. `openSocket` takes the closing
 * callback as a parameter so each client keeps owning its own runtime.
 */
import {
  Cause,
  Duration,
  Effect,
  Either,
  Exit,
  Fiber,
  Schedule,
  Scope,
  Data,
} from "effect";
import * as Socket from "@effect/platform/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";

import {
  NotConnectedError,
  RpcTimeoutError,
  type JsonRpcMethod,
} from "@moltzap/protocol";

/** Reconnect backoff: 1s base, doubling per attempt up to the cap. */
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RECONNECT_BACKOFF_FACTOR = 2;
const WEB_SOCKET_OPEN_TIMEOUT_SECONDS = 10;

/** Normal WebSocket close code (RFC 6455). */
const NORMAL_CLOSE_CODE = 1000;

/**
 * Upper bound on the graceful 1000 close-frame write during `close()`. A stalled
 * socket write must not wedge scope teardown + runtime disposal behind it.
 */
const GRACEFUL_CLOSE_WRITE_TIMEOUT = Duration.seconds(1);

/** Preview length when logging a malformed inbound frame. */

/**
 * Log 1-of-N malformed frames. A misbehaving server could flood us
 * otherwise; the counter in the log makes it clear how many we've
 * dropped between logs.
 */
const MALFORMED_LOG_EVERY = 50;

export const shouldLogMalformedFrame = (count: number): boolean =>
  count === 1 || count % MALFORMED_LOG_EVERY === 0;

/** Message both clients surface on a not-connected `sendRpc`/close. */
const MSG_NOT_CONNECTED = "WebSocket not connected";

/** Shared UTF-8 decoder for binary inbound frames. */

export const makeNotConnectedError = (): NotConnectedError =>
  new NotConnectedError({ message: MSG_NOT_CONNECTED });

/**
 * The connection-teardown both clients fork during `close()`. On a completed
 * handshake, write the graceful 1000 close frame BEFORE closing the scope so the
 * server sees a clean handshake (no lingering CLOSE_WAIT); the write is bounded
 * by {@link GRACEFUL_CLOSE_WRITE_TIMEOUT} so a stalled socket cannot wedge the
 * scope close behind it. Pre-handshake there is nothing to drain, so the scope
 * closes directly. Closing the scope also fails the engine's in-flight RPCs.
 */
export const drainConnectionEffect = (input: {
  readonly write: (
    chunk: Socket.CloseEvent,
  ) => Effect.Effect<void, Socket.SocketError>;
  readonly scope: Scope.CloseableScope;
  readonly hasCompletedHandshake: boolean;
}): Effect.Effect<void> => {
  const closeScope = Scope.close(input.scope, Exit.void);
  if (!input.hasCompletedHandshake) return closeScope;
  return input
    .write(new Socket.CloseEvent(NORMAL_CLOSE_CODE, "normal"))
    .pipe(
      Effect.timeout(GRACEFUL_CLOSE_WRITE_TIMEOUT),
      Effect.ignore,
      Effect.zipRight(closeScope),
    );
};

/**
 * Run one transport call under a per-call deadline that stays LOCAL to the
 * caller. The call is forked into the connection scope and awaited; on timeout
 * the caller fails with `RpcTimeoutError` while the forked engine fiber is left
 * untouched — so the deadline emits no wire-level cancel (`@effect/rpc/Interrupt`)
 * and does not drop the shared socket. The pending engine request then settles
 * naturally on the next server response or, on disconnect, when the connection
 * scope closes. A straight `Effect.timeoutFail` would interrupt the engine fiber
 * instead, which the native engine answers by writing an `Interrupt` frame and
 * closing the transport.
 *
 * `timeoutMs` bounds the CALLER's wait, not the forked fiber's lifetime: a
 * timed-out request lingers (one parked fiber + one pending engine entry) until
 * the server replies or the connection scope closes. The bound is the
 * connection lifetime, not per-call — a peer that holds the socket open and
 * withholds responses can park one fiber per timed-out call until the client
 * disconnects. That is the accepted cost of keeping the deadline off the wire;
 * the alternative (interrupting the request) re-introduces the `Interrupt`
 * frame and socket drop this function exists to avoid.
 *
 * Because the call is forked into the connection scope, the ONLY thing that
 * interrupts it is that scope tearing down on disconnect — the caller's own
 * fiber is the `Fiber.await` here, not the forked call. So an interrupt-only
 * exit of the forked fiber always means the transport went away (the engine
 * clears a pending value RPC this way on socket close, including a graceful 1000
 * close), and it surfaces as `NotConnectedError`. Void/notification RPCs do not
 * go through this forward-call path, so their graceful-close resolution is
 * untouched.
 */
export const callWithTimeout = <A, E>(
  scope: Scope.Scope,
  call: Effect.Effect<A, E>,
  options: { readonly method: JsonRpcMethod; readonly timeoutMs: number },
): Effect.Effect<A, E | NotConnectedError | RpcTimeoutError> =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkIn(call, scope);
    // Time out the AWAIT, not the forked call: a deadline interrupts this
    // `Fiber.await` and fails with `RpcTimeoutError`, leaving the forked fiber
    // (and its engine request) running.
    const exit = yield* Fiber.await(fiber).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(options.timeoutMs),
        onTimeout: () =>
          new RpcTimeoutError({
            method: options.method,
            timeoutMs: options.timeoutMs,
          }),
      }),
    );
    if (Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)) {
      return yield* Effect.fail(makeNotConnectedError());
    }
    return yield* exit;
  }).pipe(Effect.withSpan("callWithTimeout"));

/**
 * The reconnect loop fails each unsuccessful attempt with this so the
 * retry `Schedule` re-fires; it never escapes the loop (caught + voided).
 * Module-private: only {@link makeReconnectLoop} consumes it.
 */
class ReconnectAttemptFailedError extends Data.TaggedError(
  "ReconnectAttemptFailedError",
)<{
  readonly reason: string;
}> {}

export type ClientWebSocket = Effect.Effect.Success<
  ReturnType<typeof Socket.makeWebSocket>
>;

/**
 * Exponential backoff (1s base, ×2 per attempt) capped at 30s + jitter.
 * The retry loop discards the schedule output. Module-private: consumed
 * only by {@link makeReconnectLoop}.
 */
const makeReconnectSchedule = () =>
  Schedule.exponential(
    Duration.millis(BASE_RECONNECT_DELAY_MS),
    RECONNECT_BACKOFF_FACTOR,
  ).pipe(
    Schedule.either(Schedule.spaced(Duration.millis(MAX_RECONNECT_DELAY_MS))),
    Schedule.jittered,
  );

/** Derive the WS endpoint from the HTTP(S) server URL. */
export const webSocketUrl = (serverUrl: string): string =>
  serverUrl.replace(/^http/, "ws") + "/ws";

/**
 * The reconnect loop both clients drive from `scheduleReconnect`. Each
 * unsuccessful `connectEffect` attempt fails with {@link ReconnectAttemptFailedError}
 * so the exponential {@link makeReconnectSchedule} re-fires; a successful
 * reconnect fires `onReconnect(helloOk)` (caught + logged, never
 * propagated). The loop voids every outcome, runs `onLoopEnd` in an
 * `ensuring` finalizer (the per-client `reconnectFiber = null` reset), and
 * provides the Node WS constructor. The per-client guard
 * (`if (closed || reconnectFiber !== null) return`) + `runtime.runFork`
 * stay in each client — they touch class state the helper must not own.
 *
 * `HelloOk` is the per-client connect result (`ResultOf&lt;typeof Connect>`);
 * the helper is generic over it so `onReconnect` stays precisely typed.
 */
export const makeReconnectLoop = <HelloOk>(input: {
  readonly connectEffect: () => Effect.Effect<
    HelloOk,
    unknown,
    Socket.WebSocketConstructor
  >;
  readonly onReconnect: (helloOk: HelloOk) => void;
  readonly onLoopEnd: () => void;
}): Effect.Effect<void, never> => {
  const attempt = input.connectEffect().pipe(
    Effect.tap((helloOk) =>
      Effect.gen(function* () {
        try {
          input.onReconnect(helloOk);
        } catch (err) {
          yield* Effect.logWarning("onReconnect handler threw", err);
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
  return attempt.pipe(
    Effect.retry(makeReconnectSchedule()),
    Effect.asVoid,
    Effect.catchAll(() => Effect.void),
    Effect.ensuring(Effect.sync(input.onLoopEnd)),
    Effect.provide(NodeSocket.layerWebSocketConstructor),
    Effect.withSpan("makeReconnectLoop"),
  );
};

/**
 * Open a WebSocket under `scope`, failing fast with `NotConnectedError`
 * on open timeout or error. `closeScope` is the caller's runtime-bound
 * scope-close (each client owns its own `ManagedRuntime`), invoked to
 * tear down the half-open scope before the failure surfaces.
 */
export const openSocket = (
  url: string,
  scope: Scope.CloseableScope,
  closeScope: () => void,
): Effect.Effect<
  ClientWebSocket,
  NotConnectedError,
  Socket.WebSocketConstructor
> => {
  const openTimeout = Duration.seconds(WEB_SOCKET_OPEN_TIMEOUT_SECONDS);
  return Scope.extend(Socket.makeWebSocket(url, { openTimeout }), scope).pipe(
    Effect.timeoutFail({
      duration: openTimeout,
      onTimeout: makeNotConnectedError,
    }),
    Effect.catchAllCause((cause) =>
      Effect.zipRight(
        Effect.logWarning("WebSocket open failed", cause),
        Effect.sync(() => {
          closeScope();
        }).pipe(Effect.zipRight(Effect.fail(makeNotConnectedError()))),
      ),
    ),
  );
};
