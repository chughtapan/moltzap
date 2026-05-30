/**
 * Shared reconnecting-socket-client primitives (#705 CP-F A6-base).
 *
 * `MoltZapTMClient` (`tm-client.ts`) and `MoltZapAgentClient`
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
import { Duration, Effect, Schedule, Scope, Data } from "effect";
import * as Socket from "@effect/platform/Socket";

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
 */
export class ReconnectAttemptFailedError extends Data.TaggedError(
  "ReconnectAttemptFailedError",
)<{
  readonly reason: string;
}> {}

export type ClientWebSocket = Effect.Effect.Success<
  ReturnType<typeof Socket.makeWebSocket>
>;

/**
 * Exponential backoff (1s base, ×2 per attempt) capped at 30s and
 * jittered. The shared reconnect-loop tuning for both clients. Output
 * type is `Schedule`'s inferred `[Duration, number]` (the `either` of
 * the exponential delay and the spaced attempt count) — the reconnect
 * loop ignores the schedule output, so the exact shape is immaterial.
 */
export const makeReconnectSchedule = (): Schedule.Schedule<
  [Duration.Duration, number]
> =>
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
