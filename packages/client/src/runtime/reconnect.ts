/**
 * Shared reconnecting-socket-client primitives (#705 CP-F A6-base).
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
import { Duration, Effect, Either, Schedule, Scope, Data } from "effect";
import * as Socket from "@effect/platform/Socket";
import * as NodeSocket from "@effect/platform-node/NodeSocket";

import { NotConnectedError } from "@moltzap/protocol";

/** Reconnect backoff: 1s base, doubling per attempt up to the cap. */
const BASE_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RECONNECT_BACKOFF_FACTOR = 2;
const WEB_SOCKET_OPEN_TIMEOUT_SECONDS = 10;

/** Normal WebSocket close code (RFC 6455). */
export const NORMAL_CLOSE_CODE = 1000;

/** Preview length when logging a malformed inbound frame. */
export const MALFORMED_FRAME_PREVIEW_CHARS = 200;

/**
 * Log 1-of-N malformed frames. A misbehaving server could flood us
 * otherwise; the counter in the log makes it clear how many we've
 * dropped between logs.
 */
const MALFORMED_LOG_EVERY = 50;

export const shouldLogMalformedFrame = (count: number): boolean =>
  count === 1 || count % MALFORMED_LOG_EVERY === 0;

/** Message both clients surface on a not-connected `sendRpc`/close. */
export const MSG_NOT_CONNECTED = "WebSocket not connected";

/** Shared UTF-8 decoder for binary inbound frames. */
export const UTF8_DECODER = new TextDecoder("utf-8");

export const makeNotConnectedError = (): NotConnectedError =>
  new NotConnectedError({ message: MSG_NOT_CONNECTED });

/**
 * The reconnect loop fails each unsuccessful attempt with this so the
 * retry `Schedule` re-fires; it never escapes the loop (caught + voided).
 * Module-private: only {@link makeReconnectLoop} consumes it now (the
 * clients no longer build the loop inline — #705 CP-F A6-base).
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
 * only by {@link makeReconnectLoop} (#705 CP-F A6-base — the clients no
 * longer build the retry inline).
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
 * The byte-identical reconnect loop both clients ran inline in
 * `scheduleReconnect` (#705 CP-F A6-base). Each unsuccessful
 * `connectEffect` attempt fails with {@link ReconnectAttemptFailedError}
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
