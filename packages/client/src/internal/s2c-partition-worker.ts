/**
 * Per-partition worker — bounded queue + forked fiber, owning ordering
 * within one `(sessionId, conversationId, hookKind)` tuple.
 *
 * Spec: moltzap#356.
 *
 * Lifecycle is anchored in the dispatcher's `Scope`: `make` returns
 * `Effect<PartitionWorker, never, Scope.Scope>`, so closing the scope
 * (the per-connection scope held by `MoltZapWsClient.connectEffect`)
 * shuts the queue and interrupts the fiber. No callback unsubscribe
 * tracking; structural lifetime via `Scope`.
 *
 * Backpressure: the queue is `Queue.bounded(capacity)`. `offer` is
 * **non-blocking** — if the queue is full it fails with
 * `PartitionQueueFullError` rather than suspending the caller. The
 * reader fiber must NOT block; per-partition fullness is surfaced as
 * a typed error and translated to a wire-level error response.
 */
import { Effect, Fiber, Queue, Ref, Scope } from "effect";
import {
  PartitionQueueFullError,
} from "./s2c-dispatcher-errors.js";
import type { PartitionKey, PartitionableRequest } from "./s2c-partition-key.js";
import type { WsClientLogger } from "../ws-client.js";

/**
 * The handler the worker drains its queue against. Mirrors the existing
 * `dispatchInboundServerRequest` signature in `ws-client.ts:912-965` —
 * the dispatcher passes an already-bound function so the worker has no
 * direct knowledge of the registered s2c handler registry.
 *
 * Defects inside `handle` are caught and logged by the worker; they
 * never escape into the per-connection scope's failure channel.
 */
export type PartitionHandler = (
  request: PartitionableRequest,
) => Effect.Effect<void, never>;

/**
 * One partition's runtime state. Constructed by `makePartitionWorker`;
 * owned by the dispatcher's partition map.
 */
export interface PartitionWorker {
  /** Identity. Read-only after construction. */
  readonly key: PartitionKey;
  /**
   * Non-blocking offer. Fails with `PartitionQueueFullError` if the
   * bounded queue is at capacity; never suspends. Idempotent under
   * shutdown — post-shutdown offers fail with the same tag (queue is
   * shut down, equivalent to "no capacity").
   */
  readonly offer: (
    request: PartitionableRequest,
  ) => Effect.Effect<void, PartitionQueueFullError>;
  /**
   * Worker fiber draining the queue via `Stream.runForEach(handle)`.
   * Surfaced for `Fiber.interrupt` during forced shutdown; the
   * Scope-anchored finalizer is the primary teardown path.
   */
  readonly fiber: Fiber.RuntimeFiber<void, never>;
  /**
   * `Some(monotonicMs)` while the queue has been continuously empty
   * since `monotonicMs`; `None` whenever the queue has at least one
   * pending item or the worker is currently running a handler. The
   * dispatcher's idle reaper compares this against
   * `idlePartitionTtlMs` to decide when to retire the partition.
   */
  readonly idleSince: Ref.Ref<{ readonly _tag: "Idle"; readonly sinceMs: number } | { readonly _tag: "Busy" }>;
}

/**
 * Construction parameters for one worker. Capacity and the handler are
 * dispatcher-level config; logger is optional and matches the existing
 * `WsClientLogger` shape used elsewhere in the client package.
 */
export interface PartitionWorkerConfig {
  readonly key: PartitionKey;
  readonly capacity: number;
  readonly handle: PartitionHandler;
  readonly logger?: WsClientLogger;
}

/**
 * Build one worker. Allocates a bounded queue, forks a draining fiber
 * via `Stream.fromQueue` + `Stream.runForEach`, and registers the
 * scope finalizer that shuts the queue and interrupts the fiber on
 * scope close. Defects in `handle` are caught + logged; the fiber
 * never fails.
 */
export function makePartitionWorker(
  config: PartitionWorkerConfig,
): Effect.Effect<PartitionWorker, never, Scope.Scope> {
  throw new Error("not implemented");
}
