/**
 * Unit tests for `LeaseGuard` — initial state, first-consume, second-consume
 * (per spec C #597 AC).
 *
 * Uses Effect's TestClock so the timestamp on first consume is deterministic.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Effect, Option, TestClock, TestContext } from "effect";
import { LeaseGuard } from "../../channel-base/lease-guard.js";

const FIXED_TS = 1_700_000_000_500;
const LATER_TS = FIXED_TS + 999;
const PROPERTY_ATTEMPT_MIN = 1;
const PROPERTY_ATTEMPT_MAX = 8;
// fast-check's default `numRuns` is 100; under parallel-suite load each
// `Effect.runPromise(TestClock + 1-8 consumes)` invocation borders the 5000ms
// vitest timeout. 20 runs over the 1-8 attempt range still covers the
// boundary cases (1, 2, 8) with multiple shuffles; see #623.
const PROPERTY_NUM_RUNS = 20;

describe("LeaseGuard", () => {
  it(
    "property: only the first consume returns true; consumedAt is stamped exactly once",
    propertySingleShot,
  );
  it("initial consumedAt is Option.none", initialConsumedAtIsNone);
  it(
    "first consume returns true and stamps consumedAt with Clock.currentTimeMillis",
    firstConsumeStamps,
  );
  it(
    "second consume returns false; consumedAt unchanged",
    secondConsumeIsFalse,
  );
  it("consumedAt is idempotent on repeated reads", consumedAtIdempotent);
});

function runSingleShotAttempts(attempts: number) {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(FIXED_TS);
      const guard = new LeaseGuard();
      const results: boolean[] = [];
      for (let i = 0; i < attempts; i += 1) {
        results.push(yield* guard.consume());
      }
      const stamped = yield* guard.consumedAt;
      expect(results[0]).toBe(true);
      expect(results.slice(1)).toEqual(
        Array.from({ length: attempts - 1 }, () => false),
      );
      expect(Option.getOrNull(stamped)).toBe(FIXED_TS);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
}

function propertySingleShot() {
  return fc.assert(
    fc.asyncProperty(
      fc.integer({ min: PROPERTY_ATTEMPT_MIN, max: PROPERTY_ATTEMPT_MAX }),
      runSingleShotAttempts,
    ),
    { numRuns: PROPERTY_NUM_RUNS },
  );
}

function initialConsumedAtIsNone(): void {
  const guard = new LeaseGuard();
  expect(Option.isNone(Effect.runSync(guard.consumedAt))).toBe(true);
}

function firstConsumeStamps() {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(FIXED_TS);
      const guard = new LeaseGuard();
      const consumed = yield* guard.consume();
      const stamped = yield* guard.consumedAt;
      expect(consumed).toBe(true);
      expect(Option.getOrNull(stamped)).toBe(FIXED_TS);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
}

function secondConsumeIsFalse() {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(FIXED_TS);
      const guard = new LeaseGuard();
      const first = yield* guard.consume();
      yield* TestClock.setTime(LATER_TS);
      const second = yield* guard.consume();
      const stamped = yield* guard.consumedAt;
      expect(first).toBe(true);
      expect(second).toBe(false);
      // Unchanged from first-consume moment, NOT the wall clock at second-consume.
      expect(Option.getOrNull(stamped)).toBe(FIXED_TS);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
}

function consumedAtIdempotent(): void {
  const guard = new LeaseGuard();
  expect(Option.isNone(Effect.runSync(guard.consumedAt))).toBe(true);
  expect(Option.isNone(Effect.runSync(guard.consumedAt))).toBe(true);
}
