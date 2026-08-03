/**
 * Unit tests for `ReplyGuard` initial state, first consume, and repeated
 * consume behavior.
 *
 * Uses Effect's TestClock so the timestamp on first consume is deterministic.
 */

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Effect, Option, TestClock, TestContext } from "effect";
import { ReplyGuard } from "../../channel-base/reply-guard.js";

const FIXED_TS = 1_700_000_000_500;
const LATER_TS = FIXED_TS + 999;
const PROPERTY_ATTEMPT_MIN = 1;
const PROPERTY_ATTEMPT_MAX = 8;
// Keep the property run count low enough for parallel-suite load while still
// exercising the attempt-range boundaries with multiple shuffles.
const PROPERTY_NUM_RUNS = 20;

describe("ReplyGuard", () => {
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
  it(
    "concurrent begin claims admit exactly one sender",
    concurrentBeginAdmitsOne,
  );
  it("abort reopens an unclaimed-but-unconsumed guard", abortReopensGuard);
});

function runSingleShotAttempts(attempts: number) {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(FIXED_TS);
      const guard = new ReplyGuard();
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
  const guard = new ReplyGuard();
  expect(Option.isNone(Effect.runSync(guard.consumedAt))).toBe(true);
}

function firstConsumeStamps() {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(FIXED_TS);
      const guard = new ReplyGuard();
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
      const guard = new ReplyGuard();
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
  const guard = new ReplyGuard();
  expect(Option.isNone(Effect.runSync(guard.consumedAt))).toBe(true);
  expect(Option.isNone(Effect.runSync(guard.consumedAt))).toBe(true);
}

// The send between claim and stamp is asynchronous, so exclusivity must be
// decided at begin() time: N racing delivers admit exactly one sender even
// though none has consumed yet.
function concurrentBeginAdmitsOne() {
  return Effect.runPromise(
    Effect.gen(function* () {
      const guard = new ReplyGuard();
      const concurrentAttempts = 8;
      const claims = yield* Effect.all(
        Array.from({ length: concurrentAttempts }, () => guard.begin()),
        { concurrency: concurrentAttempts },
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
}

function abortReopensGuard() {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(FIXED_TS);
      const guard = new ReplyGuard();
      expect(yield* guard.begin()).toBe(true);
      // A failed send aborts the claim without stamping: the next deliver
      // may claim again, and consuming then stamps normally.
      yield* guard.abort();
      expect(yield* guard.begin()).toBe(true);
      expect(yield* guard.consume()).toBe(true);
      // Consumed is terminal: neither begin nor abort reopens it.
      yield* guard.abort();
      expect(yield* guard.begin()).toBe(false);
    }).pipe(Effect.provide(TestContext.TestContext)),
  );
}
