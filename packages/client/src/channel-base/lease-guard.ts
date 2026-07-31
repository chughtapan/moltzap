/**
 * Channel-base `LeaseGuard` — per-dispatch single-shot client-side dup-reply
 * detection.
 *
 * One `LeaseGuard` instance per inbound message (created inside the deliver
 * wrapper); `consume()` returns true exactly once, false on every subsequent
 * call.
 *
 * Backed by a private `number | null` field that records
 * `Clock.currentTimeMillis` on the first consume.
 */

import { Clock, Effect, Option } from "effect";

/** Implements lease guard. */
export class LeaseGuard {
  private consumedAtMillis: number | null = null;

  /**
   * Returns `true` on first call (transitions internal state from
   * "not-consumed" to "consumed-at-now"); returns `false` on every later
   * call. Reads `Clock.currentTimeMillis` inside the Effect on first call.
   * @returns The ts result.
   */
  consume(): Effect.Effect<boolean> {
    return Effect.gen(
      function* (this: LeaseGuard) {
        if (this.consumedAtMillis !== null) {
          return false;
        }
        const ts = yield* Clock.currentTimeMillis;
        this.consumedAtMillis = ts;
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
