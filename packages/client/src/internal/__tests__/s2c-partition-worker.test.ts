/**
 * Unit tests for the per-partition worker.
 *
 * Spec: moltzap#356 §8 (test plan, file 2).
 *
 * Tests run the worker in isolation against a synthetic handler. Drive
 * via `Effect.runPromise` with a dedicated `Scope`; assert ordering,
 * non-blocking offer, idle-since transitions, and scope-anchored
 * teardown.
 */
import { describe, it, expect } from "vitest";
import { Deferred, Effect, Exit, Fiber, MutableRef, Ref, Scope } from "effect";
import { makePartitionWorker } from "../s2c-partition-worker.js";
import type {
  PartitionKey,
  PartitionableRequest,
} from "../s2c-partition-key.js";

const KEY = "test-key" as PartitionKey;

const REQ = (id: string): PartitionableRequest => ({
  id,
  method: "apps/onBeforeDispatch",
  params: {},
});

/**
 * Drive a scoped Effect under a fresh Scope. Returns the Effect's
 * value plus the Scope so the caller can close it explicitly to
 * exercise scope-anchored teardown.
 */
function withScope<A, E>(
  body: (scope: Scope.CloseableScope) => Effect.Effect<A, E>,
): Effect.Effect<A, E> {
  return Effect.gen(function* () {
    const scope = yield* Scope.make();
    const result = yield* body(scope);
    yield* Scope.close(scope, Exit.void);
    return result;
  });
}

/**
 * Spin until the worker's queue is drained (size === 0). Used to
 * synchronize with the worker fiber having actually taken an item
 * off the queue and started running its handler.
 */
function waitUntilQueueDrained(worker: {
  queueSize: Effect.Effect<number>;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    for (let i = 0; i < 1000; i++) {
      const size = yield* worker.queueSize;
      if (size === 0) return;
      yield* Effect.yieldNow();
    }
  });
}

describe("makePartitionWorker — ordering", () => {
  it("preserves FIFO order across N offers to the same worker", async () => {
    const result = await Effect.runPromise(
      withScope((scope) =>
        Effect.gen(function* () {
          const seen = yield* Ref.make<string[]>([]);
          const allDone = yield* Deferred.make<void>();
          const handle = (req: PartitionableRequest) =>
            Effect.gen(function* () {
              yield* Ref.update(seen, (xs) => [...xs, req.id]);
              const xs = yield* Ref.get(seen);
              if (xs.length === 5) {
                yield* Deferred.succeed(allDone, undefined);
              }
            });
          const worker = yield* makePartitionWorker({
            key: KEY,
            capacity: 16,
            handle,
            scope,
          });
          for (let i = 0; i < 5; i++) {
            yield* worker.offer(REQ(`rpc-${i}`));
          }
          yield* Deferred.await(allDone);
          return yield* Ref.get(seen);
        }),
      ),
    );
    expect(result).toEqual(["rpc-0", "rpc-1", "rpc-2", "rpc-3", "rpc-4"]);
  });

  it("handler defects are caught and logged; subsequent offers still run", async () => {
    const result = await Effect.runPromise(
      withScope((scope) =>
        Effect.gen(function* () {
          const seen = yield* Ref.make<string[]>([]);
          const second = yield* Deferred.make<void>();
          const handle = (req: PartitionableRequest) =>
            Effect.gen(function* () {
              yield* Ref.update(seen, (xs) => [...xs, req.id]);
              if (req.id === "rpc-bad") {
                return yield* Effect.die("synthetic defect");
              }
              if (req.id === "rpc-good") {
                yield* Deferred.succeed(second, undefined);
              }
            });
          const worker = yield* makePartitionWorker({
            key: KEY,
            capacity: 16,
            handle,
            logger: { info: () => {}, warn: () => {}, error: () => {} },
            scope,
          });
          yield* worker.offer(REQ("rpc-bad"));
          yield* worker.offer(REQ("rpc-good"));
          yield* Deferred.await(second);
          return yield* Ref.get(seen);
        }),
      ),
    );
    expect(result).toEqual(["rpc-bad", "rpc-good"]);
  });
});

describe("makePartitionWorker — backpressure", () => {
  it("offer to full bounded queue fails-fast with PartitionQueueFullError (does NOT suspend)", async () => {
    const verdict = await Effect.runPromise(
      withScope((scope) =>
        Effect.gen(function* () {
          // Park every handler on a Deferred so the queue fills.
          const release = yield* Deferred.make<void>();
          const handle = () => Deferred.await(release);
          const capacity = 2;
          const worker = yield* makePartitionWorker({
            key: KEY,
            capacity,
            handle,
            scope,
          });

          // First offer goes to the handler; yield so the worker
          // fiber consumes it and parks on `release`. Then the queue
          // is empty. Fill it: capacity offers land, the (capacity+1)th
          // must fail fast.
          yield* worker.offer(REQ("rpc-1"));
          // Spin until the worker fiber has drained rpc-1 off the
          // queue and parked the handler on `release`. We assert on
          // queueSize === 0 (not idleSince) because `worker.offer`
          // flips idleSince to Busy synchronously, before the worker
          // fiber takes the item.
          yield* waitUntilQueueDrained(worker);
          yield* worker.offer(REQ("rpc-2"));
          yield* worker.offer(REQ("rpc-3"));

          const overflow = yield* Effect.either(worker.offer(REQ("rpc-4")));
          yield* Deferred.succeed(release, undefined);
          return overflow;
        }),
      ),
    );
    expect(verdict._tag).toBe("Left");
    if (verdict._tag === "Left") {
      expect(verdict.left._tag).toBe("PartitionQueueFullError");
    }
  });

  it("offer after Scope close fails with PartitionQueueFullError (queue shut down)", async () => {
    const verdict = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const handle = () => Effect.void;
        const worker = yield* makePartitionWorker({
          key: KEY,
          capacity: 4,
          handle,
          scope,
        });
        yield* Scope.close(scope, Exit.void);
        // Give the finalizer a chance to run.
        yield* Effect.yieldNow();
        return yield* Effect.either(worker.offer(REQ("rpc-late")));
      }),
    );
    expect(verdict._tag).toBe("Left");
    if (verdict._tag === "Left") {
      expect(verdict.left._tag).toBe("PartitionQueueFullError");
    }
  });
});

describe("makePartitionWorker — idle-since clock", () => {
  it("idleSince is Busy while a request is queued or in-flight", async () => {
    const verdict = await Effect.runPromise(
      withScope((scope) =>
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>();
          const handle = () => Deferred.await(release);
          const worker = yield* makePartitionWorker({
            key: KEY,
            capacity: 4,
            handle,
            scope,
          });
          yield* worker.offer(REQ("rpc-1"));
          // Yield so the worker fiber transitions to Busy.
          yield* Effect.yieldNow();
          yield* Effect.yieldNow();
          const state = MutableRef.get(worker.idleSince);
          yield* Deferred.succeed(release, undefined);
          return state._tag;
        }),
      ),
    );
    expect(verdict).toBe("Busy");
  });

  it("idleSince transitions to Idle{sinceMs} after the queue drains and the handler returns", async () => {
    const verdict = await Effect.runPromise(
      withScope((scope) =>
        Effect.gen(function* () {
          const done = yield* Deferred.make<void>();
          const handle = (_req: PartitionableRequest) =>
            Deferred.succeed(done, undefined).pipe(Effect.asVoid);
          const fakeNow = yield* Ref.make(1000);
          const clock = () => Effect.runSync(Ref.get(fakeNow));
          const worker = yield* makePartitionWorker({
            key: KEY,
            capacity: 4,
            handle,
            clock,
            scope,
          });
          // Bump clock so the post-drain Idle.sinceMs is observably new.
          yield* Ref.set(fakeNow, 5000);
          yield* worker.offer(REQ("rpc-1"));
          yield* Deferred.await(done);
          // Yield so the worker's post-handler `MutableRef.set(Idle, …)`
          // commits before we observe.
          yield* Effect.yieldNow();
          yield* Effect.yieldNow();
          return MutableRef.get(worker.idleSince);
        }),
      ),
    );
    expect(verdict._tag).toBe("Idle");
    if (verdict._tag === "Idle") {
      expect(verdict.sinceMs).toBe(5000);
    }
  });

  it("idleSince resets to Busy when a new request is offered", async () => {
    const verdict = await Effect.runPromise(
      withScope((scope) =>
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>();
          const handle = () => Deferred.await(release);
          const worker = yield* makePartitionWorker({
            key: KEY,
            capacity: 4,
            handle,
            scope,
          });
          yield* worker.offer(REQ("rpc-1"));
          yield* Effect.yieldNow();
          const busyState = MutableRef.get(worker.idleSince);
          yield* Deferred.succeed(release, undefined);
          return busyState._tag;
        }),
      ),
    );
    expect(verdict).toBe("Busy");
  });
});

describe("makePartitionWorker — scope teardown", () => {
  it("Scope.close interrupts the worker fiber and shuts the queue (no hang)", async () => {
    const fiberDone = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const handle = () => Effect.void;
        const worker = yield* makePartitionWorker({
          key: KEY,
          capacity: 4,
          handle,
          scope,
        });
        yield* Scope.close(scope, Exit.void);
        // Wait for the fiber to settle. `Fiber.await` returns when the
        // fiber exits — for a healthy teardown this is immediate.
        const exit = yield* Fiber.await(worker.fiber);
        return Exit.isInterrupted(exit) || Exit.isSuccess(exit);
      }),
    );
    expect(fiberDone).toBe(true);
  });

  it("Scope.close while handler is suspended on Deferred.await interrupts cleanly", async () => {
    const fiberDone = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const release = yield* Deferred.make<void>();
        const handle = () => Deferred.await(release);
        const worker = yield* makePartitionWorker({
          key: KEY,
          capacity: 4,
          handle,
          scope,
        });
        yield* worker.offer(REQ("rpc-suspended"));
        yield* Effect.yieldNow();
        // Close while the handler is parked on Deferred.await. The
        // worker fiber must interrupt cleanly without hanging.
        yield* Scope.close(scope, Exit.void);
        const exit = yield* Fiber.await(worker.fiber);
        return Exit.isInterrupted(exit) || Exit.isSuccess(exit);
      }),
    );
    expect(fiberDone).toBe(true);
  });
});
