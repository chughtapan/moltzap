/**
 * Channel-base `ReplyGuard` — per-turn single-shot duplicate-reply detection.
 *
 * One `ReplyGuard` instance per inbound turn (created inside the deliver
 * wrapper); `consume()` returns true exactly once, false on every subsequent
 * call. This is the only enforcement of "one final reply per inbound turn":
 * the server accepts every well-formed send, so a runtime that delivers twice
 * would otherwise double-post.
 *
 * Backed by a private `number | null` field that records
 * `Clock.currentTimeMillis` on the first consume.
 */

import { Clock, Effect, Option } from "effect";

/** Implements reply guard. */
export class ReplyGuard {
  private consumedAtMillis: number | null = null;

  /**
   * Returns `true` on first call (transitions internal state from
   * "not-consumed" to "consumed-at-now"); returns `false` on every later
   * call. Reads `Clock.currentTimeMillis` inside the Effect on first call.
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
