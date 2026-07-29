import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { makeSuccessMemo } from "./cache.js";

const ACQUIRED_VALUE = { state: "ready" } as const;
const REPAIRED_VALUE = { state: "repaired" } as const;
const EXPECTED_FAILURE = Symbol("expected acquisition failure");

describe("success memo", () => {
  it("retries after a failed acquisition", retriesAfterFailure);
  it("retries after an interrupted acquisition", retriesAfterInterruption);
});

function retriesAfterFailure() {
  return Effect.runPromise(
    Effect.gen(function* () {
      const memo = yield* makeSuccessMemo<string, typeof ACQUIRED_VALUE>();
      let attempts = 0;
      const acquire = Effect.suspend(() => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail(EXPECTED_FAILURE)
          : Effect.succeed(ACQUIRED_VALUE);
      });

      expect(
        yield* memo.getOrAcquire("runtime", acquire).pipe(Effect.flip),
      ).toBe(EXPECTED_FAILURE);
      expect(yield* memo.getOrAcquire("runtime", acquire)).toBe(ACQUIRED_VALUE);
      expect(
        yield* memo.getOrAcquire(
          "runtime",
          Effect.die("cached success must bypass acquisition"),
        ),
      ).toBe(ACQUIRED_VALUE);
      expect(attempts).toBe(2);
    }),
  );
}

function retriesAfterInterruption() {
  return Effect.runPromise(
    Effect.gen(function* () {
      const memo = yield* makeSuccessMemo<string, typeof REPAIRED_VALUE>();
      const started = yield* Deferred.make<void>();
      const interrupted = yield* memo
        .getOrAcquire(
          "runtime",
          Deferred.succeed(started, undefined).pipe(
            Effect.zipRight(Effect.never),
          ),
        )
        .pipe(Effect.fork);

      yield* Deferred.await(started);
      yield* Fiber.interrupt(interrupted);
      expect(
        yield* memo.getOrAcquire("runtime", Effect.succeed(REPAIRED_VALUE)),
      ).toBe(REPAIRED_VALUE);
    }),
  );
}
