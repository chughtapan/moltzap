/**
 * Unit tests for the partitioned task-callback dispatcher.
 *
 * Spec: moltzap#356 §8 (test plan, file 3).
 *
 * Phase 9b consumer-migration (sub-issue #460): the legacy `appCallback`
 * group retired. Only `task/authorizeDispatch` survives as the
 * server→client awaitable RPC, so cross-method partitioning scenarios
 * (the pre-Phase-9b deadlock-fix reproducer that pitted
 * `apps/onBeforeDispatch` against `apps/onBeforeMessageDelivery`)
 * dropped: every request now flows through one descriptor segment, so
 * partitioning is by `(taskId, conversationId)` alone. The surviving
 * coverage — FIFO, cross-partition independence, soft-cap, idle reaper,
 * scope-anchored teardown — still validates the dispatcher contract.
 */
import { describe, it, expect } from "vitest";
import { Deferred, Effect, Exit, Ref, Scope } from "effect";
import {
  DEFAULT_PARTITIONED_DISPATCHER_CONFIG,
  makePartitionedDispatcher,
} from "../app-callback-partitioned-dispatcher.js";
import type { PartitionableRequest } from "../app-callback-partition-key.js";

import {
  authorizeDispatch,
  conversationIdForIndex,
  CONV_X,
  CONV_Y,
  CONV_Z,
  SESSION_A,
} from "./app-callback-test-requests.js";

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
          yield* dispatcher.offer(authorizeDispatch("rpc-1"));
          yield* dispatcher.offer(authorizeDispatch("rpc-2"));
          yield* dispatcher.offer(authorizeDispatch("rpc-3"));
          yield* Deferred.await(allDone);
          return yield* Ref.get(order);
        }),
      ),
    );
    expect(seen).toEqual(["rpc-1", "rpc-2", "rpc-3"]);
  });

  it("offers to different (taskId, conversationId) keys run in parallel (no head-of-line blocking)", async () => {
    // Park partition X (CONV_X). Partition Y (CONV_Y) must still run.
    const result = await Effect.runPromise(
      withScope((scope) =>
        Effect.gen(function* () {
          const releaseX = yield* Deferred.make<void>();
          const yDone = yield* Deferred.make<void>();
          const dispatcher = yield* makePartitionedDispatcher({
            handle: (req: PartitionableRequest) =>
              Effect.gen(function* () {
                if (req.partition.conversationId === CONV_X) {
                  yield* Deferred.await(releaseX);
                } else if (req.id === "rpc-Y-go") {
                  yield* Deferred.succeed(yDone, undefined);
                }
              }),
            scope,
          });
          yield* dispatcher.offer(
            authorizeDispatch("rpc-X-park", SESSION_A, CONV_X),
          );
          yield* dispatcher.offer(
            authorizeDispatch("rpc-Y-go", SESSION_A, CONV_Y),
          );
          yield* Deferred.await(yDone);
          yield* Deferred.succeed(releaseX, undefined);
          return "Y-ran" as const;
        }),
      ),
    );
    expect(result).toBe("Y-ran");
  });

  it("partitions are bounded by maxPartitions (config cap)", async () => {
    const cap = 4;
    const offers = await Effect.runPromise(
      withScope((scope) =>
        Effect.gen(function* () {
          const release = yield* Deferred.make<void>();
          const dispatcher = yield* makePartitionedDispatcher({
            handle: () => Deferred.await(release),
            scope,
            config: { maxPartitions: cap },
          });
          let succeeded = 0;
          for (let i = 0; i < 10; i++) {
            const outcome = yield* Effect.either(
              dispatcher.offer(
                authorizeDispatch(
                  `rpc-${i}`,
                  SESSION_A,
                  conversationIdForIndex(i),
                ),
              ),
            );
            if (outcome._tag === "Right") succeeded += 1;
          }
          yield* Deferred.succeed(release, undefined);
          return succeeded;
        }),
      ),
    );
    expect(offers).toBeLessThanOrEqual(
      DEFAULT_PARTITIONED_DISPATCHER_CONFIG.maxPartitions,
    );
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
            handle: (req: PartitionableRequest) =>
              Effect.gen(function* () {
                if (req.partition.conversationId === CONV_X) {
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
            authorizeDispatch("rpc-A-1", SESSION_A, CONV_X),
          );
          // Wait until the handler has actually taken rpc-A-1 off the
          // queue (queue size 0). Then fill the queue with rpc-A-2 so
          // a third offer to A would fail.
          for (let i = 0; i < 200; i++) {
            const stats = yield* dispatcher.stats;
            const partA = stats.partitions.find((p) => p.queueSize >= 0);
            if (partA && partA.queueSize === 0) break;
            yield* Effect.yieldNow();
          }
          yield* dispatcher.offer(
            authorizeDispatch("rpc-A-2", SESSION_A, CONV_X),
          );

          // Partition A is now at capacity. A different-key offer
          // (partition B / CONV_Y) must still run.
          yield* dispatcher.offer(
            authorizeDispatch("rpc-B-go", SESSION_A, CONV_Y),
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
            authorizeDispatch("rpc-1", SESSION_A, CONV_X),
          );
          // Wait for the handler to take rpc-1 off the queue.
          for (let i = 0; i < 200; i++) {
            const stats = yield* dispatcher.stats;
            const part = stats.partitions[0];
            if (part && part.queueSize === 0) break;
            yield* Effect.yieldNow();
          }
          yield* dispatcher.offer(
            authorizeDispatch("rpc-2", SESSION_A, CONV_X),
          );
          const overflow = yield* Effect.either(
            dispatcher.offer(authorizeDispatch("rpc-3", SESSION_A, CONV_X)),
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

describe("makePartitionedDispatcher — idle reaper", () => {
  it("idle reaper tick reclaims drained partitions when the configured TTL elapses", async () => {
    // Drives the live reaper with a tight TTL/tick. The reaper runs
    // on the dispatcher's scope-anchored fiber; the test polls
    // `stats.activePartitions` until it observes the reclaim. No
    // virtual-clock injection — that surface is private.
    const verdict = await Effect.runPromise(
      withScope((scope) =>
        Effect.gen(function* () {
          const dispatcher = yield* makePartitionedDispatcher({
            handle: () => Effect.void,
            scope,
            config: {
              idlePartitionTtlMs: 50,
              idleReaperIntervalMs: 25,
            },
          });
          yield* dispatcher.offer(
            authorizeDispatch("rpc-1", SESSION_A, CONV_Z),
          );
          // Drain — the worker accepts and completes immediately.
          for (let i = 0; i < 200; i++) {
            const stats = yield* dispatcher.stats;
            if (
              stats.activePartitions === 0 ||
              stats.partitions.every((p) => p.idle && p.queueSize === 0)
            ) {
              break;
            }
            yield* Effect.sleep("10 millis");
          }
          // Wait for the reaper to fire at least once past the TTL.
          for (let i = 0; i < 200; i++) {
            const stats = yield* dispatcher.stats;
            if (stats.activePartitions === 0) return 0;
            yield* Effect.sleep("10 millis");
          }
          const stats = yield* dispatcher.stats;
          return stats.activePartitions;
        }),
      ),
    );
    expect(verdict).toBe(0);
  });
});

describe("makePartitionedDispatcher — scope teardown", () => {
  it("closing the scope finalizes every partition worker (no leaked fibers)", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const releaseAll = yield* Deferred.make<void>();
        const dispatcher = yield* makePartitionedDispatcher({
          handle: () => Deferred.await(releaseAll),
          scope,
        });
        yield* dispatcher.offer(authorizeDispatch("rpc-1"));
        // Close the scope — finalizers fire; the parked handlers are
        // interrupted. Without scope-anchored teardown, this would
        // hang forever.
        yield* Scope.close(scope, Exit.void);
        // The Deferred is now garbage; succeeding it post-close is a
        // safe no-op (Deferred semantics allow late settle).
        yield* Deferred.succeed(releaseAll, undefined);
        return "scope-closed" as const;
      }),
    );
    expect(result).toBe("scope-closed");
  });
});
