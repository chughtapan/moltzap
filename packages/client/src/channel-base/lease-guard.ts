/**
 * Channel-base `LeaseGuard` — per-dispatch single-shot client-side dup-reply
 * detection.
 *
 * Replaces openclaw's `consumedLeaseAt: number | null` closure in
 * `packages/openclaw-channel/src/openclaw-entry.ts → createLeaseConsumingDeliver`.
 * One `LeaseGuard` instance per inbound message (created inside the deliver
 * wrapper); `consume()` returns true exactly once, false on every subsequent
 * call.
 *
 * Backed by a private `number | null` field that records
 * `Clock.currentTimeMillis` on the first consume.
 */

import { Clock, Effect, Option } from "effect";

export class LeaseGuard {
  #consumedAt: number | null = null;

  /**
   * Returns `true` on first call (transitions internal state from
   * "not-consumed" to "consumed-at-now"); returns `false` on every later
   * call. Reads `Clock.currentTimeMillis` inside the Effect on first call.
   */
  consume(): Effect.Effect<boolean, never, never> {
    return Effect.gen(this, function* () {
      if (this.#consumedAt !== null) return false;
      const ts = yield* Clock.currentTimeMillis;
      this.#consumedAt = ts;
      return true;
    });
  }

  /**
   * `Option.none` before the first `consume`; `Option.some(epochMs)` after,
   * where `epochMs` is the value Clock returned at the first-consume moment.
   * Idempotent on second-and-later reads.
   */
  get consumedAt(): Effect.Effect<Option.Option<number>, never, never> {
    return Effect.sync(() =>
      this.#consumedAt === null ? Option.none() : Option.some(this.#consumedAt),
    );
  }
}
