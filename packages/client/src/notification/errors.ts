/**
 * @file Defines closed tagged failures for notification consumers and records
 * the terminal condition that ends an otherwise empty stream.
 *
 * `Data.TaggedError` classes do NOT compose via class inheritance —
 * extending one tagged class from another produces broken `_tag`
 * discrimination at runtime. The shared abstraction is therefore a TYPE
 * UNION (`NotificationConsumerError`) not a base class. Catch sites that
 * want to handle "any notification consumer error" pattern-match on the
 * union.
 *
 * `NotificationTimeoutError` carries the timeout duration so callers can
 * log + retry with sane backoff. `StreamClosedError` fires when the
 * consumer's Stream completes empty (e.g. The client transitioned to
 * terminal closed state before a notification arrived); its `reason`
 * discriminant names WHICH close-state ended the Stream.
 */
import { Data } from "effect";

/** Reports notification timeout failures. */
export class NotificationTimeoutError extends Data.TaggedError(
  "NotificationTimeoutError",
)<{
  readonly definition: string;
  readonly durationMs: number;
}> {}

/**
 * Why a notification Stream terminated without a `NotificationTimeoutError`:
 *
 * - `"client-closed"` — `MoltZapWsClient.close()` tore the transport down
 *   (the registry's `closeAll` fired each subscription's `onClose`).
 * - `"stream-completed"` — the Stream source completed normally with no
 *   further frames pending (graceful end-of-stream, not an error condition).
 * - `"transport-disconnected"` — the transport dropped. The current
 *   subscription is terminal even if its owner later starts a new connection.
 */
export type StreamCloseReason =
  | "client-closed"
  | "stream-completed"
  | "transport-disconnected";

/** Reports stream closed failures. */
export class StreamClosedError extends Data.TaggedError("StreamClosedError")<{
  readonly definition: string;
  readonly reason: StreamCloseReason;
}> {}

/**
 * Union of all notification consumer error tags. Catch sites use
 * `Effect.catchTags({ NotificationTimeoutError: ..., StreamClosedError: ... })`
 * for exhaustive handling, or accept this union in their typed error channel.
 *
 * NOT a class — Effect's `Data.TaggedError` classes do not inherit from
 * a shared `Data.TaggedError` base in a way that preserves `_tag`
 * discrimination. The union is the canonical shape.
 */
export type NotificationConsumerError =
  | NotificationTimeoutError
  | StreamClosedError;
