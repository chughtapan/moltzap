/**
 * Unit tests for the partitioned s2c dispatcher.
 *
 * Spec: moltzap#356 §8 (test plan, file 3).
 *
 * Covers routing, partition allocation, the soft cap, the idle reaper,
 * and the deadlock scenario at the dispatcher boundary (without the
 * full AppHost stack — that's the conformance + integration tests).
 */
import { describe, it } from "vitest";

describe("makePartitionedDispatcher — routing", () => {
  it.todo("two offers with the same key land on the same worker (FIFO preserved)");
  it.todo("two offers with different keys execute concurrently (no FIFO between them)");
  it.todo("offer with malformed params returns MalformedPartitionKeyError");
});

describe("makePartitionedDispatcher — soft cap", () => {
  it.todo("allocates up to maxPartitions partitions");
  it.todo("(N+1)th distinct key returns PartitionLimitError when no idle partition is reclaimable");
  it.todo("(N+1)th distinct key reclaims an idle partition when one is available");
});

describe("makePartitionedDispatcher — backpressure", () => {
  it.todo("partitionQueueFull on partition A does not block partition B (independent fibers)");
  it.todo("PartitionQueueFullError propagates without queue.shutdown side-effect");
});

describe("makePartitionedDispatcher — deadlock fix (D10 reproducer at dispatcher level)", () => {
  it.todo(
    "before_dispatch suspended on Deferred.await does NOT block before_message_delivery " +
      "for the same (sessionId, conversationId) — release path completes; suspended fiber resumes",
  );
});

describe("makePartitionedDispatcher — idle reaper", () => {
  it.todo("worker idle past idlePartitionTtlMs is finalized on next reaper tick");
  it.todo("worker that becomes Busy before TTL is NOT reaped");
  it.todo("reaper interval is bounded (one reaper fiber, not one per partition)");
});

describe("makePartitionedDispatcher — scope teardown", () => {
  it.todo("Scope.close finalizes every partition worker (no leak)");
  it.todo("Scope.close interrupts the idle-reaper fiber");
});

describe("makePartitionedDispatcher — runSync(close()) contract (regression of ws-client.test.ts:1248)", () => {
  it.todo(
    "runtime.runFork(Scope.close(dispatcherScope, Exit.void)) returns immediately " +
      "even when a worker is mid-handler (no AsyncFiberException leaks)",
  );
  it.todo(
    "Effect.runSync(client.close()) succeeds after a partitioned dispatcher has " +
      "allocated and torn down workers",
  );
});
