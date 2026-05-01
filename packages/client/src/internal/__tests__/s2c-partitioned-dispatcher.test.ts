/**
 * Unit tests for the partitioned s2c dispatcher.
 *
 * Spec: moltzap#356 §8 (test plan, file 3).
 *
 * Covers routing, partition allocation, the soft cap, the idle reaper,
 * and the deadlock scenario at the dispatcher boundary (without the
 * full AppHost stack — that's the conformance + integration tests).
 */
import { describe, it, expect } from "vitest";
import { Deferred, Effect, Exit, Ref, Scope } from "effect";
import {
  DEFAULT_PARTITIONED_DISPATCHER_CONFIG,
  makePartitionedDispatcher,
} from "../s2c-partitioned-dispatcher.js";
import type { PartitionableRequest } from "../s2c-partition-key.js";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const CONV_X = "conv-X";
const CONV_Y = "conv-Y";

const reqBeforeDispatch = (
  id: string,
  sessionId = SESSION_A,
  conv = CONV_X,
): PartitionableRequest => ({
  id,
  method: "apps/onBeforeDispatch",
  params: { sessionId, conversationId: conv },
});

const reqBeforeMessageDelivery = (
  id: string,
  sessionId = SESSION_A,
  conv = CONV_X,
): PartitionableRequest => ({
  id,
  method: "apps/onBeforeMessageDelivery",
  params: { sessionId, conversationId: conv },
});

const reqLifecycle = (
  id: string,
  method = "apps/onJoin",
  sessionId = SESSION_A,
): PartitionableRequest => ({
  id,
  method,
  params: { sessionId },
});

/** Drive a body under a fresh CloseableScope; close on exit. */
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

describe("makePartitionedDispatcher — routing", () => {
  it("two offers with the same key land on the same worker (FIFO preserved)", async () => {
    const seen = await Effect.runPromise(
      withScope((scope) =>
        Effect.gen(function* () {
          const order = yield* Ref.make<string[]>([]);
          const allDone = yield* Deferred.make<void>();
          const dispatcher = yield* makePartitionedDispatcher({
            handle: (req) =>
              Effect.gen(function* () {
                yield* Ref.update(order, (xs) => [...xs, req.id]);
                const xs = yield* Ref.get(order);
                if (xs.length === 3) {
                  yield* Deferred.succeed(allDone, undefined);
                }
              }),
            scope,
          });
          yield* dispatcher.offer(reqBeforeDispatch("rpc-1"));
          yield* dispatcher.offer(reqBeforeDispatch("rpc-2"));
          yield* dispatcher.offer(reqBeforeDispatch("rpc-3"));
          yield* Deferred.await(allDone);
          return yield* Ref.get(order);
        }),
      ),
    );
    expect(seen).toEqual(["rpc-1", "rpc-2", "rpc-3"]);
  });

  it("two offers with different keys execute concurrently (no FIFO between them)", async () => {
    // Different keys (A=session A, conv X; B=session A, conv Y) on
    // independent fibers. Park request-A on a Deferred; request-B
    // must complete BEFORE we release request-A. If routing
    // collapsed onto one fiber, request-B would never run.
    const result = await Effect.runPromise(
      withScope((scope) =>
        Effect.gen(function* () {
          const releaseA = yield* Deferred.make<void>();
          const bDone = yield* Deferred.make<void>();
          const handle = (req: PartitionableRequest) =>
            Effect.gen(function* () {
              if (req.id === "rpc-A-park") {
                yield* Deferred.await(releaseA);
              } else if (req.id === "rpc-B-go") {
                yield* Deferred.succeed(bDone, undefined);
              }
            });
          const dispatcher = yield* makePartitionedDispatcher({
            handle,
            scope,
          });
          yield* dispatcher.offer(
            reqBeforeDispatch("rpc-A-park", SESSION_A, CONV_X),
          );
          yield* dispatcher.offer(
            reqBeforeDispatch("rpc-B-go", SESSION_A, CONV_Y),
          );
          // bDone fires only if rpc-B ran without being blocked by
          // rpc-A's parked Deferred.
          yield* Deferred.await(bDone);
          // Release rpc-A so the test's Scope.close doesn't have to
          // interrupt a parked fiber.
          yield* Deferred.succeed(releaseA, undefined);
          return "concurrent" as const;
        }),
      ),
    );
    expect(result).toBe("concurrent");
  });

  it("offer with malformed params returns MalformedPartitionKeyError", async () => {
    const verdict = await Effect.runPromise(
      withScope((scope) =>
        Effect.gen(function* () {
          const dispatcher = yield* makePartitionedDispatcher({
            handle: () => Effect.void,
            scope,
          });
          return yield* Effect.either(
            dispatcher.offer({
              id: "rpc-x",
              method: "apps/onBeforeDispatch",
              params: { /* sessionId missing */ conversationId: CONV_X },
            }),
          );
        }),
      ),
    );
    expect(verdict._tag).toBe("Left");
    if (verdict._tag === "Left") {
      expect(verdict.left._tag).toBe("MalformedPartitionKeyError");
    }
  });
});

describe("makePartitionedDispatcher — soft cap", () => {
  it("allocates up to maxPartitions partitions", async () => {
    const verdict = await Effect.runPromise(
      withScope((scope) =>
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>();
          const dispatcher = yield* makePartitionedDispatcher({
            handle: () => Deferred.await(release),
            scope,
            config: { maxPartitions: 4 },
          });
          // Distinct conversationIds → distinct keys → distinct
          // partitions, all parked on `release`.
          for (let i = 0; i < 4; i++) {
            yield* dispatcher.offer(
              reqBeforeDispatch(`rpc-${i}`, SESSION_A, `conv-${i}`),
            );
          }
          const stats = yield* dispatcher.stats;
          yield* Deferred.succeed(release, undefined);
          return stats.activePartitions;
        }),
      ),
    );
    expect(verdict).toBe(4);
  });

  it("(N+1)th distinct key returns PartitionLimitError when no idle partition is reclaimable", async () => {
    const verdict = await Effect.runPromise(
      withScope((scope) =>
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>();
          const dispatcher = yield* makePartitionedDispatcher({
            handle: () => Deferred.await(release),
            scope,
            config: { maxPartitions: 2 },
          });
          yield* dispatcher.offer(
            reqBeforeDispatch("rpc-1", SESSION_A, "conv-A"),
          );
          yield* dispatcher.offer(
            reqBeforeDispatch("rpc-2", SESSION_A, "conv-B"),
          );
          // Third distinct key → should fail with PartitionLimitError.
          const overflow = yield* Effect.either(
            dispatcher.offer(reqBeforeDispatch("rpc-3", SESSION_A, "conv-C")),
          );
          yield* Deferred.succeed(release, undefined);
          return overflow;
        }),
      ),
    );
    expect(verdict._tag).toBe("Left");
    if (verdict._tag === "Left") {
      expect(verdict.left._tag).toBe("PartitionLimitError");
    }
  });
});

describe("makePartitionedDispatcher — backpressure", () => {
  it("partitionQueueFull on partition A does not block partition B (independent fibers)", async () => {
    // Park partition A's handler so its queue fills; offer to
    // partition B must still succeed and run.
    const result = await Effect.runPromise(
      withScope((scope) =>
        Effect.gen(function* () {
          const releaseA = yield* Deferred.make<void>();
          const bDone = yield* Deferred.make<void>();
          const dispatcher = yield* makePartitionedDispatcher({
            handle: (req) =>
              Effect.gen(function* () {
                if (req.method === "apps/onBeforeDispatch") {
                  yield* Deferred.await(releaseA);
                } else if (req.id === "rpc-B-go") {
                  yield* Deferred.succeed(bDone, undefined);
                }
              }),
            scope,
            config: { partitionQueueCapacity: 1 },
          });
          // Start partition A; first offer goes into the handler.
          yield* dispatcher.offer(
            reqBeforeDispatch("rpc-A-1", SESSION_A, CONV_X),
          );
          // Wait until the handler has actually taken rpc-A-1 off the
          // queue (queue size 0). Then fill the queue with rpc-A-2 so
          // a third offer to A would fail.
          for (let i = 0; i < 200; i++) {
            const stats = yield* dispatcher.stats;
            const partA = stats.partitions.find((p) =>
              p.key.includes("apps/onBeforeDispatch"),
            );
            if (partA && partA.queueSize === 0) break;
            yield* Effect.yieldNow();
          }
          yield* dispatcher.offer(
            reqBeforeDispatch("rpc-A-2", SESSION_A, CONV_X),
          );

          // Partition A is now at capacity. A third offer to A would
          // fail. Meanwhile a different-key offer (partition B) must
          // still run.
          yield* dispatcher.offer(
            reqBeforeMessageDelivery("rpc-B-go", SESSION_A, CONV_X),
          );
          yield* Deferred.await(bDone);
          yield* Deferred.succeed(releaseA, undefined);
          return "B-ran" as const;
        }),
      ),
    );
    expect(result).toBe("B-ran");
  });

  it("PartitionQueueFullError is returned when one partition fills, leaving sibling partitions unaffected", async () => {
    // Verify the exact failure tag. Park A's handler, fill the queue,
    // then push one more — it should fail with PartitionQueueFullError.
    const verdict = await Effect.runPromise(
      withScope((scope) =>
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>();
          const dispatcher = yield* makePartitionedDispatcher({
            handle: () => Deferred.await(release),
            scope,
            config: { partitionQueueCapacity: 1 },
          });
          yield* dispatcher.offer(
            reqBeforeDispatch("rpc-1", SESSION_A, CONV_X),
          );
          // Wait for the handler to take rpc-1 off the queue.
          for (let i = 0; i < 200; i++) {
            const stats = yield* dispatcher.stats;
            const part = stats.partitions[0];
            if (part && part.queueSize === 0) break;
            yield* Effect.yieldNow();
          }
          yield* dispatcher.offer(
            reqBeforeDispatch("rpc-2", SESSION_A, CONV_X),
          );
          const overflow = yield* Effect.either(
            dispatcher.offer(reqBeforeDispatch("rpc-3", SESSION_A, CONV_X)),
          );
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
});

describe("makePartitionedDispatcher — deadlock fix (D10 reproducer at dispatcher level)", () => {
  it("before_dispatch suspended on Deferred.await does NOT block before_message_delivery " +
    "for the same (sessionId, conversationId) — release path completes; suspended fiber resumes", async () => {
    // Direct reproducer of arena#248. Dispatcher boundary version of
    // the conformance + integration tests.
    //
    //   1. Server sends `apps/onBeforeDispatch` for (S, C). Handler
    //      parks on `releaseDispatch`.
    //   2. Server sends `apps/onBeforeMessageDelivery` for the SAME
    //      (S, C) — handler runs, succeeds `releaseDispatch`.
    //   3. The parked dispatch handler resumes and completes.
    //
    // Pre-#356 (single-fiber dispatcher): step 2 queues behind
    // step 1; release never fires; parked Deferred sleeps forever.
    // Post-#356 (partitioned): different `hookKind` → different
    // key → different fiber → step 2 runs concurrently.
    const result = await Effect.runPromise(
      withScope((scope) =>
        Effect.gen(function* () {
          const releaseDispatch = yield* Deferred.make<void>();
          const dispatchDone = yield* Deferred.make<void>();
          const deliveryDone = yield* Deferred.make<void>();
          const dispatcher = yield* makePartitionedDispatcher({
            handle: (req) =>
              Effect.gen(function* () {
                if (req.method === "apps/onBeforeDispatch") {
                  // Park.
                  yield* Deferred.await(releaseDispatch);
                  yield* Deferred.succeed(dispatchDone, undefined);
                } else if (req.method === "apps/onBeforeMessageDelivery") {
                  // The lease-release hook in arena's pattern. Run
                  // to completion and signal the dispatch path to
                  // resume.
                  yield* Deferred.succeed(releaseDispatch, undefined);
                  yield* Deferred.succeed(deliveryDone, undefined);
                }
              }),
            scope,
          });
          // Step 1: park dispatch handler.
          yield* dispatcher.offer(
            reqBeforeDispatch("rpc-dispatch-1", SESSION_A, CONV_X),
          );
          // Step 2: send delivery handler for the SAME conversation.
          yield* dispatcher.offer(
            reqBeforeMessageDelivery("rpc-delivery-1", SESSION_A, CONV_X),
          );
          // Both must complete. With pre-#356 single-fiber
          // dispatch, this hangs forever (the test's `runPromise`
          // would never resolve — vitest's `testTimeout` would
          // catch it).
          yield* Deferred.await(deliveryDone);
          yield* Deferred.await(dispatchDone);
          return "no-deadlock" as const;
        }),
      ),
    );
    expect(result).toBe("no-deadlock");
  }, /* per-test timeout = */ 5000);
});

describe("makePartitionedDispatcher — idle reaper", () => {
  it("worker idle past idlePartitionTtlMs is finalized on next reaper tick", async () => {
    const verdict = await Effect.runPromise(
      withScope((scope) =>
        Effect.gen(function* () {
          // Inject a virtual clock so the test doesn't sleep.
          const fakeNow = yield* Ref.make(0);
          const clock = () => Effect.runSync(Ref.get(fakeNow));
          const dispatcher = yield* makePartitionedDispatcher({
            handle: () => Effect.void,
            scope,
            clock,
            config: {
              idlePartitionTtlMs: 100,
              idleReaperIntervalMs: 10,
            },
          });
          yield* dispatcher.offer(
            reqBeforeDispatch("rpc-1", SESSION_A, CONV_X),
          );
          // Wait for the handler to finish so the partition becomes
          // Idle.
          for (let i = 0; i < 200; i++) {
            const stats = yield* dispatcher.stats;
            const part = stats.partitions[0];
            if (part && part.idle) break;
            yield* Effect.yieldNow();
          }
          // Bump the virtual clock past the TTL.
          yield* Ref.set(fakeNow, 10_000);
          // Reaper ticks every idleReaperIntervalMs. Wait up to
          // ~500ms wall-clock for the reaper to observe the bump and
          // finalize the partition.
          let finalized = false;
          for (let i = 0; i < 50; i++) {
            const stats = yield* dispatcher.stats;
            if (stats.activePartitions === 0) {
              finalized = true;
              break;
            }
            yield* Effect.sleep("20 millis");
          }
          return finalized;
        }),
      ),
    );
    expect(verdict).toBe(true);
  });

  it("worker that becomes Busy before TTL is NOT reaped", async () => {
    const verdict = await Effect.runPromise(
      withScope((scope) =>
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>();
          const fakeNow = yield* Ref.make(0);
          const clock = () => Effect.runSync(Ref.get(fakeNow));
          const dispatcher = yield* makePartitionedDispatcher({
            handle: () => Deferred.await(release),
            scope,
            clock,
            config: {
              idlePartitionTtlMs: 100,
              idleReaperIntervalMs: 10,
            },
          });
          yield* dispatcher.offer(
            reqBeforeDispatch("rpc-busy", SESSION_A, CONV_X),
          );
          // Bump clock past TTL while handler is still parked. Reaper
          // sees `idleSince._tag === "Busy"` and skips reclamation.
          yield* Ref.set(fakeNow, 10_000);
          // Give reaper several ticks.
          yield* Effect.sleep("100 millis");
          const stats = yield* dispatcher.stats;
          yield* Deferred.succeed(release, undefined);
          return stats.activePartitions;
        }),
      ),
    );
    expect(verdict).toBe(1);
  });
});

describe("makePartitionedDispatcher — scope teardown", () => {
  it("Scope.close finalizes every partition worker (no leak)", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const release = yield* Deferred.make<void>();
        const dispatcher = yield* makePartitionedDispatcher({
          handle: () => Deferred.await(release),
          scope,
        });
        yield* dispatcher.offer(reqBeforeDispatch("rpc-1"));
        yield* dispatcher.offer(reqBeforeMessageDelivery("rpc-2"));
        yield* dispatcher.offer(reqLifecycle("rpc-3", "apps/onJoin"));
        // Close while every handler is parked. Must not hang.
        yield* Scope.close(scope, Exit.void);
        // Release any awaiters (no-op if scope close already
        // interrupted the worker fibers).
        yield* Deferred.succeed(release, undefined).pipe(Effect.ignore);
        return "torn-down" as const;
      }),
    );
    expect(result).toBe("torn-down");
  });
});

describe("makePartitionedDispatcher — runSync(close()) contract (regression of ws-client.test.ts:1248)", () => {
  it("dispatcher.shutdown is safe to runFork from a runSync context", async () => {
    // dispatcher.shutdown closes the dispatcher's Scope. The Scope
    // close yields through the runtime (queue.shutdown +
    // fiber.interrupt are async), so it must NOT be runSync-able by
    // the caller — but `runFork` must succeed without throwing.
    // This mirrors the ws-client.ts invocation pattern.
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const dispatcher = yield* makePartitionedDispatcher({
          handle: () => Effect.void,
          scope,
        });
        yield* dispatcher.offer(reqBeforeDispatch("rpc-1"));
        // Use Effect.runFork-equivalent via Effect.forkDaemon — a
        // runSync caller wraps `Scope.close(...)` similarly.
        const fiber = yield* Effect.forkDaemon(Scope.close(scope, Exit.void));
        yield* fiber.await;
      }),
    );
    expect(true).toBe(true);
  });
});

describe("makePartitionedDispatcher — defaults", () => {
  it("DEFAULT_PARTITIONED_DISPATCHER_CONFIG carries the architect's documented values", () => {
    expect(DEFAULT_PARTITIONED_DISPATCHER_CONFIG.maxPartitions).toBe(256);
    expect(DEFAULT_PARTITIONED_DISPATCHER_CONFIG.partitionQueueCapacity).toBe(
      32,
    );
    expect(DEFAULT_PARTITIONED_DISPATCHER_CONFIG.idlePartitionTtlMs).toBe(
      60_000,
    );
    expect(DEFAULT_PARTITIONED_DISPATCHER_CONFIG.idleReaperIntervalMs).toBe(
      5_000,
    );
  });
});
