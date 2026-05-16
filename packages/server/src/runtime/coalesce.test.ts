import { it as effectIt } from "@effect/vitest";
import * as fc from "fast-check";
import {
  Cause,
  Data,
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
import { describe, expect } from "vitest";
import { coalesce, drainCoalesceMap } from "./coalesce.js";

const it = effectIt.effect;

const COALESCE_TIMEOUT_MS = 200;
const PROPERTY_RUNS = 25;
const SAME_KEY = "k";
const SUCCESS_VALUE = "ok";
const WORK_FAILURE_MESSAGE = "boom";
const SAME_KEY_REQUESTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const FAILURE_WAITERS = [1, 2, 3, 4, 5] as const;

class CoalesceTimeoutError extends Data.TaggedError("CoalesceTimeoutError") {}

describe("coalesce success", () => {
  const successProperty = fc.property(
    fc.string(),
    assertSuccessfulCoalesceValue,
  );

  it("concurrent fibers on same key share a single work run", () =>
    Effect.gen(function* () {
      const ref = yield* makeMapRef<number, never>();
      const counter = yield* Ref.make(0);
      const work = countedWork(counter);

      const results = yield* runConcurrentCoalesce(ref, work);
      const total = yield* Ref.get(counter);

      expect(total).toBe(1);
      expectAllResults(results, 1);
    }));

  it("property: success resolves with the work value and clears the map", () =>
    Effect.sync(() => {
      expect.hasAssertions();
      fc.assert(successProperty, { numRuns: PROPERTY_RUNS });
    }));

  it("map entry is removed after success", () =>
    Effect.gen(function* () {
      const ref = yield* makeMapRef<string, never>();

      const result = yield* coalesce(
        ref,
        SAME_KEY,
        Effect.succeed(SUCCESS_VALUE),
      );
      expect(result).toBe(SUCCESS_VALUE);

      const map = yield* Ref.get(ref);
      expect(HashMap.size(map)).toBe(0);
    }));
});

describe("coalesce failure", () => {
  it("failure propagates to all waiters and entry is removed", () =>
    Effect.gen(function* () {
      const ref = yield* makeMapRef<number, string>();
      const counter = yield* Ref.make(0);
      const work = failingCountedWork(counter);

      const exits = yield* runConcurrentCoalesceExits(ref, work);

      for (const exit of exits) {
        expectFailureValue(exit, WORK_FAILURE_MESSAGE);
      }

      expect(yield* Ref.get(counter)).toBe(1);
      const map = yield* Ref.get(ref);
      expect(HashMap.size(map)).toBe(0);
    }));
});

describe("coalesce timeout propagation", () => {
  it("sanity: forkDaemon + Effect.timeoutFail propagates to a Deferred under TestClock", () =>
    Effect.gen(function* () {
      const deferred = yield* Deferred.make<number, CoalesceTimeoutError>();
      const work = timeoutWork();

      yield* forkExitIntoDeferred(work, deferred);
      yield* Effect.yieldNow();
      yield* TestClock.adjust(Duration.millis(COALESCE_TIMEOUT_MS));

      const exit = yield* Effect.exit(Deferred.await(deferred));
      expect(Exit.isFailure(exit)).toBe(true);
    }));

  it("Effect.timeoutFail inside work propagates to awaiters via Deferred.failCause", () =>
    Effect.gen(function* () {
      const ref = yield* makeMapRef<number, CoalesceTimeoutError>();
      const work = timeoutWork();
      const fiber = yield* Effect.fork(coalesceExit(ref, work));

      yield* Effect.yieldNow();
      yield* TestClock.adjust(Duration.millis(COALESCE_TIMEOUT_MS));

      const exit = yield* Fiber.join(fiber);
      expectFailureInstance(exit, CoalesceTimeoutError);

      const map = yield* Ref.get(ref);
      expect(HashMap.size(map)).toBe(0);
    }));
});

describe("drainCoalesceMap", () => {
  it("drainCoalesceMap interrupts pending waiters and clears the map", () =>
    Effect.gen(function* () {
      const ref = yield* makeMapRef<string, never>();
      const fiber = yield* Effect.fork(coalesce(ref, SAME_KEY, Effect.never));

      yield* Effect.yieldNow();
      const beforeDrain = yield* Ref.get(ref);
      expect(HashMap.size(beforeDrain)).toBe(1);

      yield* drainCoalesceMap(ref);

      const exit = yield* fiber.await;
      expect(Exit.isInterrupted(exit)).toBe(true);

      const afterDrain = yield* Ref.get(ref);
      expect(HashMap.size(afterDrain)).toBe(0);
    }));
});

const makeMapRef = <A, E>() =>
  Ref.make(HashMap.empty<string, Deferred.Deferred<A, E>>());

function countedWork(counter: Ref.Ref<number>) {
  return Effect.gen(function* () {
    const n = yield* Ref.updateAndGet(counter, (x) => x + 1);
    yield* Effect.yieldNow();
    return n;
  });
}

function failingCountedWork(counter: Ref.Ref<number>) {
  return Effect.gen(function* () {
    yield* Ref.update(counter, (x) => x + 1);
    yield* Effect.yieldNow();
    return yield* Effect.fail(WORK_FAILURE_MESSAGE);
  });
}

function runConcurrentCoalesce<A, E>(
  ref: Ref.Ref<HashMap.HashMap<string, Deferred.Deferred<A, E>>>,
  work: Effect.Effect<A, E>,
) {
  return Effect.forEach(SAME_KEY_REQUESTS, coalesceSameKey(ref, work), {
    concurrency: SAME_KEY_REQUESTS.length,
  });
}

function runConcurrentCoalesceExits<A, E>(
  ref: Ref.Ref<HashMap.HashMap<string, Deferred.Deferred<A, E>>>,
  work: Effect.Effect<A, E>,
) {
  return Effect.forEach(FAILURE_WAITERS, coalesceSameKeyExit(ref, work), {
    concurrency: FAILURE_WAITERS.length,
  });
}

function coalesceSameKey<A, E>(
  ref: Ref.Ref<HashMap.HashMap<string, Deferred.Deferred<A, E>>>,
  work: Effect.Effect<A, E>,
) {
  return () => coalesce(ref, SAME_KEY, work);
}

function coalesceSameKeyExit<A, E>(
  ref: Ref.Ref<HashMap.HashMap<string, Deferred.Deferred<A, E>>>,
  work: Effect.Effect<A, E>,
) {
  return () => coalesceExit(ref, work);
}

function coalesceExit<A, E>(
  ref: Ref.Ref<HashMap.HashMap<string, Deferred.Deferred<A, E>>>,
  work: Effect.Effect<A, E>,
) {
  return Effect.exit(coalesce(ref, SAME_KEY, work));
}

function assertSuccessfulCoalesceValue(value: string) {
  const snapshot = Effect.runSync(successfulCoalesceSnapshot(value));
  expect(snapshot.result).toBe(value);
  expect(snapshot.mapSize).toBe(0);
}

function successfulCoalesceSnapshot(value: string) {
  return Effect.gen(function* () {
    const ref = yield* makeMapRef<string, never>();
    const result = yield* coalesce(ref, SAME_KEY, Effect.succeed(value));
    const map = yield* Ref.get(ref);
    return { result, mapSize: HashMap.size(map) };
  });
}

function timeoutWork() {
  return Effect.async<number, CoalesceTimeoutError>(() => undefined).pipe(
    Effect.timeoutFail({
      duration: Duration.millis(COALESCE_TIMEOUT_MS),
      onTimeout: () => new CoalesceTimeoutError(),
    }),
  );
}

function forkExitIntoDeferred<A, E>(
  work: Effect.Effect<A, E>,
  deferred: Deferred.Deferred<A, E>,
) {
  return Effect.forkDaemon(
    work.pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        Exit.matchEffect(exit, {
          onFailure: (cause) => Deferred.failCause(deferred, cause),
          onSuccess: (value) => Deferred.succeed(deferred, value),
        }),
      ),
    ),
  );
}

function expectAllResults<A>(results: readonly A[], expected: A) {
  for (const result of results) {
    expect(result).toBe(expected);
  }
}

function failureOption<E>(exit: Exit.Exit<unknown, E>): Option.Option<E> {
  return Exit.match(exit, {
    onFailure: Cause.failureOption,
    onSuccess: () => Option.none(),
  });
}

function expectFailureValue<E>(exit: Exit.Exit<unknown, E>, expected: E) {
  const actual = Option.match(failureOption(exit), {
    onNone: () => undefined,
    onSome: (error) => error,
  });
  expect(actual).toBe(expected);
}

function expectFailureInstance<E>(
  exit: Exit.Exit<unknown, E>,
  expectedClass: abstract new (...args: never[]) => E,
) {
  const matchesExpectedClass = Option.match(failureOption(exit), {
    onNone: () => false,
    onSome: (error) => error instanceof expectedClass,
  });
  expect(matchesExpectedClass).toBe(true);
}
