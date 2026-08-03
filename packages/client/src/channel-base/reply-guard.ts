/**
 * Channel-base `ReplyGuard` — per-turn single-shot duplicate-reply detection.
 *
 * One `ReplyGuard` instance per inbound turn (created inside the deliver
 * wrapper). This is the only enforcement of "one final reply per inbound
 * turn": the server accepts every well-formed send, so a runtime that
 * delivers twice would otherwise double-post.
 *
 * The send a guard protects is asynchronous, so a bare consumed check is a
 * race: two concurrent delivers can both observe "not consumed" before
 * either send completes. `begin()` therefore claims the guard in one
 * synchronous step BEFORE the send; `consume()` stamps after a successful
 * send; `abort()` reopens the guard after a failed send so a retried
 * deliver can still go through. A deliver arriving while another is
 * mid-send is a duplicate, not a queued retry.
 */

import { Clock, Effect, Option } from "effect";

/** Implements reply guard. */
export class ReplyGuard {
  private consumedAtMillis: number | null = null;
  private inFlight = false;

  /**
   * Claim the guard for one send attempt. `true` exactly once per open
   * window: `false` when the guard is already consumed OR another send is
   * mid-flight. The claim is taken synchronously, so concurrent callers
   * cannot both win.
   * @returns Whether this caller owns the send attempt.
   */
  begin(): Effect.Effect<boolean> {
    return Effect.sync(() => {
      if (this.consumedAtMillis !== null || this.inFlight) {
        return false;
      }
      this.inFlight = true;
      return true;
    });
  }

  /**
   * Reopen the guard after a failed send so a retried deliver can claim it
   * again. No-op when the guard is already consumed.
   * @returns Completion of the reopen.
   */
  abort(): Effect.Effect<void> {
    return Effect.sync(() => {
      this.inFlight = false;
    });
  }

  /**
   * Returns `true` on first call (transitions internal state from
   * "not-consumed" to "consumed-at-now") and releases any in-flight claim;
   * returns `false` on every later call. Reads `Clock.currentTimeMillis`
   * inside the Effect on first call.
   * @returns The ts result.
   */
  consume(): Effect.Effect<boolean> {
    return Effect.gen(
      function* (this: ReplyGuard) {
        if (this.consumedAtMillis !== null) {
          return false;
        }
        const ts = yield* Clock.currentTimeMillis;
        this.consumedAtMillis = ts;
        this.inFlight = false;
        return true;
      }.bind(this),
    );
  }

  /**
   * `Option.none` before the first `consume`; `Option.some(epochMs)` after,
   * where `epochMs` is the value Clock returned at the first-consume moment.
   * Idempotent on second-and-later reads.
   * @returns The consumed at result.
   */
  get consumedAt(): Effect.Effect<Option.Option<number>> {
    return Effect.sync(() =>
      this.consumedAtMillis === null
        ? Option.none()
        : Option.some(this.consumedAtMillis),
    );
  }
}
