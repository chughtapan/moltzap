/**
 * Tagged errors for the notification consumption surface (Spec B, #596).
 *
 * Per architect-revision r1 (codex review finding #8): `Data.TaggedError`
 * classes do NOT compose via class inheritance — extending one tagged
 * class from another produces broken `_tag` discrimination at runtime.
 * The shared abstraction is therefore a TYPE UNION (`NotificationConsumerError`)
 * not a base class. Catch sites that want to handle "any notification
 * consumer error" pattern-match on the union.
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

export class TimeoutError extends Data.TaggedError("TimeoutError")<{
  readonly definition: string;
  readonly durationMs: number;
}> {}

export class StreamClosedError extends Data.TaggedError("StreamClosedError")<{
  readonly definition: string;
}> {}

/**
 * Union of all notification consumer error tags. Catch sites use
 * `Effect.catchTags({ TimeoutError: ..., StreamClosedError: ... })` for
 * exhaustive handling, or accept this union in their typed error channel.
 *
 * NOT a class — Effect's `Data.TaggedError` classes do not inherit from
 * a shared `Data.TaggedError` base in a way that preserves `_tag`
 * discrimination. The union is the canonical shape.
 */
export type NotificationConsumerError = TimeoutError | StreamClosedError;
