import { it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  HashMap,
  Option,
  Ref,
  TestClock,
} from "effect";
import { expect } from "vitest";
import { coalesce, drainCoalesceMap } from "./coalesce.js";

/**
 * Fresh Ref for each test — we never share state across cases, so races
 * inside one test don't leak into another.
 */
const makeMapRef = <A, E>() =>
  Ref.make(HashMap.empty<string, Deferred.Deferred<A, E>>());

it.effect("concurrent fibers on same key share a single work run", () =>
  Effect.gen(function* () {
    const ref = yield* makeMapRef<number, never>();
    const counter = yield* Ref.make(0);

    // Work bumps the counter and then succeeds with the observed count.
    // If coalesce is race-safe, `counter` hits exactly 1 regardless of
    // how many fibers race past `Ref.modify` simultaneously.
    const work = Effect.gen(function* () {
      const n = yield* Ref.updateAndGet(counter, (x) => x + 1);
      // Yield once so sibling fibers actually get scheduled in between
      // — without this, `Effect.gen` can run to completion synchronously
      // and the test never exercises the race at all.
      yield* Effect.yieldNow();
      return n;
    });

    // Unbounded concurrency on the same key: every fiber hits
    // `coalesce(ref, "k", work)` at roughly the same instant.
    const results = yield* Effect.forEach(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      () => coalesce(ref, "k", work),
      { concurrency: "unbounded" },
    );

    // Exactly one `work` invocation — if the `Ref.modify` + deferred
    // install weren't atomic, `counter` would exceed 1.
    const total = yield* Ref.get(counter);
    expect(total).toBe(1);

    // Every waiter saw the same result (value 1 — the single run).
    for (const r of results) {
      expect(r).toBe(1);
    }
  }),
);

it.effect("map entry is removed after success", () =>
  Effect.gen(function* () {
    const ref = yield* makeMapRef<string, never>();

    const result = yield* coalesce(ref, "k", Effect.succeed("ok"));
    expect(result).toBe("ok");

    // Post-success: the map must be empty so a subsequent call with the
    // same key starts a fresh work run (no stale Deferred resolves
    // instantly with the previous run's value).
    const map = yield* Ref.get(ref);
    expect(HashMap.size(map)).toBe(0);
  }),
);

it.effect("failure propagates to all waiters and entry is removed", () =>
  Effect.gen(function* () {
    const ref = yield* makeMapRef<number, string>();
    const counter = yield* Ref.make(0);

    const work = Effect.gen(function* () {
      yield* Ref.update(counter, (x) => x + 1);
      yield* Effect.yieldNow();
      return yield* Effect.fail("boom");
    });

    const exits = yield* Effect.forEach(
      [1, 2, 3, 4, 5],
      () => Effect.exit(coalesce(ref, "k", work)),
      { concurrency: "unbounded" },
    );

    for (const exit of exits) {
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const fail = Cause.failureOption(exit.cause);
        expect(Option.isSome(fail)).toBe(true);
        if (Option.isSome(fail)) {
          expect(fail.value).toBe("boom");
        }
      }
    }

    // Work still ran exactly once.
    expect(yield* Ref.get(counter)).toBe(1);

    // Map is empty after failure — next call starts fresh.
    const map = yield* Ref.get(ref);
    expect(HashMap.size(map)).toBe(0);
  }),
);

// ─────────────────────────────────────────────────────────────────────
// Regression: timeouts inside `work` must propagate to awaiters.
// ─────────────────────────────────────────────────────────────────────
//
// `requestPermission` in `AppHost` wraps an `Effect.async` with
// `Effect.timeoutFail` and runs inside `coalesce(..., work)`. Observed
// regression: integration tests for permission-timeout hung because
// the caller's `Deferred.await` never saw the timeout failure.
//
// These tests drive virtual time through `TestClock.adjust` to prove
// the fix: daemon fiber runs `work`, timeout fires INSIDE `work`, the
// daemon's `Effect.exit` captures the failure cause, and
// `Deferred.failCause` routes it to every awaiter.

// Sanity check BEFORE coalesce: does a plain forkDaemon + Effect.timeoutFail
// propagate a timeout through a Deferred under TestClock at all?
it.effect(
  "sanity: forkDaemon + Effect.timeoutFail propagates to a Deferred under TestClock",
  () =>
    Effect.gen(function* () {
      class BoomError extends Error {
        constructor() {
          super("BOOM");
        }
      }

      const deferred = yield* Deferred.make<number, BoomError>();

      const work = Effect.async<number, BoomError>((_resume) => {
        // never resumes
      }).pipe(
        Effect.timeoutFail({
          duration: Duration.millis(200),
          onTimeout: () => new BoomError(),
        }),
      );

      yield* Effect.forkDaemon(
        work.pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            exit._tag === "Success"
              ? Deferred.succeed(deferred, exit.value)
              : Deferred.failCause(deferred, exit.cause),
          ),
        ),
      );

      yield* Effect.yieldNow();
      yield* TestClock.adjust(Duration.millis(200));

      const exit = yield* Effect.exit(Deferred.await(deferred));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
);

it.effect(
  "Effect.timeoutFail inside work propagates to awaiters via Deferred.failCause",
  () =>
    Effect.gen(function* () {
      class BoomError extends Error {
        constructor() {
          super("BOOM");
        }
      }

      const ref = yield* makeMapRef<number, BoomError>();

      const work = Effect.async<number, BoomError>((_resume) => {
        // never resumes
      }).pipe(
        Effect.timeoutFail({
          duration: Duration.millis(200),
          onTimeout: () => new BoomError(),
        }),
      );

      const fiber = yield* Effect.fork(Effect.exit(coalesce(ref, "k", work)));

      yield* Effect.yieldNow();
      yield* TestClock.adjust(Duration.millis(200));

      const exit = yield* Fiber.join(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const fail = Cause.failureOption(exit.cause);
        expect(Option.isSome(fail)).toBe(true);
        if (Option.isSome(fail)) {
          expect(fail.value).toBeInstanceOf(BoomError);
        }
      }

      const map = yield* Ref.get(ref);
      expect(HashMap.size(map)).toBe(0);
    }),
);

it.effect(
  "drainCoalesceMap interrupts pending waiters and clears the map",
  () =>
    Effect.gen(function* () {
      const ref = yield* makeMapRef<string, never>();

      // Work that never completes on its own — only drainCoalesceMap will
      // unblock it, via Deferred.interrupt.
      const blocked = Effect.never as Effect.Effect<string, never>;

      // Fork the waiter so we can drain the map while it's still pending.
      const fiber = yield* Effect.fork(coalesce(ref, "k", blocked));

      // Give the fork a tick to install its Deferred in the map.
      yield* Effect.yieldNow();
      const beforeDrain = yield* Ref.get(ref);
      expect(HashMap.size(beforeDrain)).toBe(1);

      yield* drainCoalesceMap(ref);

      // Waiter sees interruption, not a value or a typed failure.
      const exit = yield* fiber.await;
      expect(Exit.isInterrupted(exit)).toBe(true);

      // Map was cleared.
      const afterDrain = yield* Ref.get(ref);
      expect(HashMap.size(afterDrain)).toBe(0);
    }),
);
