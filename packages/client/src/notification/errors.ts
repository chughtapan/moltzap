/**
 * Tagged errors for the notification consumption surface (Spec B, #596).
 *
 * `NotificationConsumerError` is the tagged base for failures observable to
 * callers of `MoltZapWsClient.subscribe` / `subscribeAll` (and the
 * `Stream.runHead` + `Effect.timeoutFail` migration recipe documented in
 * spec #596 §Acceptance criteria).
 *
 * `TimeoutError` carries the timeout duration so callers can log + retry
 * with sane backoff. `StreamClosedError` fires when the consumer's Stream
 * completes empty (e.g. the client transitioned to terminal closed state
 * before a notification arrived).
 *
 * **Architect stub** (Spec B). Impl-staff fills any helper combinators
 * (`isTimeoutError`, mapping helpers) per downstream consumer needs.
 */
import { Data } from "effect";

export class NotificationConsumerError extends Data.TaggedError(
  "NotificationConsumerError",
)<{
  readonly definition: string;
}> {}

export class TimeoutError extends Data.TaggedError("TimeoutError")<{
  readonly definition: string;
  readonly durationMs: number;
}> {}

export class StreamClosedError extends Data.TaggedError("StreamClosedError")<{
  readonly definition: string;
}> {}
