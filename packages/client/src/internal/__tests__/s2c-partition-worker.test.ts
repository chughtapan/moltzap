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
import { describe, it } from "vitest";

describe("makePartitionWorker — ordering", () => {
  it.todo("preserves FIFO order across N offers to the same worker");
  it.todo("handler defects are caught and logged; subsequent offers still run");
});

describe("makePartitionWorker — backpressure", () => {
  it.todo("offer to full bounded queue fails-fast with PartitionQueueFullError (does NOT suspend)");
  it.todo("offer after Scope close fails with PartitionQueueFullError (queue shut down)");
});

describe("makePartitionWorker — idle-since clock", () => {
  it.todo("idleSince is Busy while a request is queued or in-flight");
  it.todo("idleSince transitions to Idle{sinceMs} after the queue drains and the handler returns");
  it.todo("idleSince resets to Busy when a new request is offered");
});

describe("makePartitionWorker — scope teardown", () => {
  it.todo("Scope.close interrupts the worker fiber and shuts the queue (no hang)");
  it.todo("Scope.close while handler is suspended on Deferred.await interrupts cleanly");
});
