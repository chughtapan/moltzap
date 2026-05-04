/**
 * Per-partition worker — bounded queue + forked fiber, owning ordering
 * within one `(sessionId, conversationId, hookKind)` tuple.
 *
 * Spec: moltzap#356.
 *
 * Lifecycle is anchored in a per-worker `Scope.CloseableScope` provided
 * by the dispatcher (`app-callback-partitioned-dispatcher.ts`'s
 * `getOrCreatePartitionWorker` calls `Scope.fork(dispatcherScope, …)`
 * for each new worker and hands the child scope in via the config).
 * Closing the worker's scope shuts the queue, runs registered
 * finalizers, and interrupts the drain fiber — cascading finalization
 * with no orphan references on the dispatcher scope. Closing the
 * dispatcher scope still cascades to every worker via the parent-child
 * scope link from `Scope.fork`.
 *
 * Backpressure: the queue is `Queue.bounded(capacity)`. `offer` is
 * **non-blocking** — if the queue is full it fails with
 * `PartitionQueueFullError` rather than suspending the caller. The
 * reader fiber must NOT block; per-partition fullness is surfaced as
 * a typed error and translated to a wire-level error response.
 *
 * Single-producer guarantee: only the dispatcher's reader-fiber path
 * calls `offer` for any given partition. That makes the
 * `Queue.size + offer` pre-check race-free for "full" detection: if
 * size < capacity at the check, the subsequent `offer` cannot suspend
 * because no other producer can fill the queue between check and
 * offer. The drain fiber only consumes; it cannot push us past
 * capacity.
 *
 * Why `idleSince` is a `MutableRef` (synchronous cell) rather than a
 * `Ref`: the dispatcher's reaper inspects `idleSince._tag === "Idle"`
 * inside a `Ref.modify` lambda over the partition map (synchronous
 * lambda body — no `yield`). A `Ref.get` would require an Effect step
 * we cannot take inside the lambda; `MutableRef.get` is synchronous.
 * Producer (offer) and drain-loop sites use `MutableRef.set`. JS's
 * single-threaded execution model makes the `Idle ↔ Busy` transitions
 * race-free between fibers, and the dispatcher's atomic
 * `Ref.modify(partitionsRef)` is the synchronization point that
 * ensures snapshot+remove on idle partitions runs without an offer
 * landing in between.
 */
import { Cause, Effect, Fiber, MutableRef, Queue, Scope, Stream } from "effect";
import { PartitionQueueFullError } from "./app-callback-dispatcher-errors.js";
import type {
  PartitionKey,
  PartitionableRequest,
} from "./app-callback-partition-key.js";
import type { WsClientLogger } from "../ws-client.js";

/**
 * The handler the worker drains its queue against. Mirrors the existing
 * `dispatchInboundServerRequest` signature in `ws-client.ts:912-965` —
 * the dispatcher passes an already-bound function so the worker has no
 * direct knowledge of the registered appCallback handler registry.
 *
 * Defects inside `handle` are caught and logged by the worker; they
 * never escape into the per-connection scope's failure channel.
 */
export type PartitionHandler = (
  request: PartitionableRequest,
) => Effect.Effect<void, never>;

/**
 * Idle / busy / retiring sum-type tracked per worker. See
 * `PartitionWorker.idleSince`.
 *
 * - `Idle` — drain queue empty, last handler returned at `sinceMs`.
 *   Eligible for reap once `sinceMs` ages past `idlePartitionTtlMs`.
 * - `Busy` — handler running OR producer has reserved this worker
 *   for a pending `Queue.offer`. Reaper skips Busy workers.
 * - `Retiring` — reaper has claimed this worker for teardown
 *   (transition done atomically inside the reaper's `Ref.modify`
 *   lambda over the partition map). Producer's `worker.offer` MUST
 *   refuse to enqueue when it observes `Retiring`; otherwise the
 *   reaper's `Scope.close` would silently drop the just-enqueued
 *   request, leaving the server-side `Deferred.await` to time out.
 */
export type IdleSince =
  | { readonly _tag: "Idle"; readonly sinceMs: number }
  | { readonly _tag: "Busy" }
  | { readonly _tag: "Retiring" };

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
   * Surfaced for observability + tests; the worker's `Scope.close` is
   * the canonical teardown path (it triggers the queue.shutdown
   * finalizer and interrupts the fiber via the scope cascade).
   */
  readonly fiber: Fiber.RuntimeFiber<void, never>;
  /**
   * Idle-since tracker. `Busy` while the worker has a request queued
   * or a handler running; `Idle{sinceMs}` once the queue drains and
   * the handler returns. Stored in a `MutableRef` so the dispatcher's
   * reaper can read it synchronously inside its `Ref.modify` lambda
   * over the partition map (the atomic check that prevents a reaped
   * worker from receiving a concurrent offer between snapshot and
   * removal).
   */
  readonly idleSince: MutableRef.MutableRef<IdleSince>;
  /**
   * Live queue size for `DispatcherStats`. Reaper does not consult
   * this — it gates strictly on `idleSince._tag === "Idle"` to avoid
   * races where the queue snapshot misses an in-flight item.
   */
  readonly queueSize: Effect.Effect<number>;
  /**
   * The closeable scope owning this worker's finalizers (queue
   * shutdown, drain fiber). Forked from the dispatcher's scope by
   * `getOrCreatePartitionWorker`; closing it cleanly retires the
   * worker without orphaning finalizers on the parent dispatcher
   * scope.
   */
  readonly scope: Scope.CloseableScope;
}

/**
 * Construction parameters for one worker. Capacity and the handler are
 * dispatcher-level config; `scope` is the per-worker closeable scope
 * the dispatcher allocated via `Scope.fork`; logger is optional and
 * matches the existing `WsClientLogger` shape used elsewhere in the
 * client package.
 */
export interface PartitionWorkerConfig {
  readonly key: PartitionKey;
  readonly capacity: number;
  readonly handle: PartitionHandler;
  /**
   * Per-worker scope owning every finalizer this worker registers
   * (queue shutdown + drain fiber). The dispatcher's reaper closes
   * this scope to retire the worker. Closing the parent dispatcher
   * scope cascades through it via `Scope.fork`.
   */
  readonly scope: Scope.CloseableScope;
  readonly logger?: WsClientLogger;
  /** Monotonic clock for tests; defaults to `Date.now`. */
  readonly clock?: () => number;
}

/**
 * Build one worker. Allocates a bounded queue, forks a draining fiber
 * via `Stream.fromQueue` + `Stream.runForEach`, and registers the
 * scope finalizer that shuts the queue. Defects in `handle` are
 * caught + logged; the fiber never fails.
 *
 * Returns `Effect<PartitionWorker, never>` — no `Scope.Scope`
 * requirement. All scoped allocations (queue finalizer, forked drain
 * fiber) are bound to the caller-provided `config.scope` via
 * `Scope.extend`.
 */
export function makePartitionWorker(
  config: PartitionWorkerConfig,
): Effect.Effect<PartitionWorker, never> {
  const clock = config.clock ?? Date.now;
  return Scope.extend(
    Effect.gen(function* () {
      const queue = yield* Queue.bounded<PartitionableRequest>(config.capacity);
      const idleSince = MutableRef.make<IdleSince>({
        _tag: "Idle",
        sinceMs: clock(),
      });

      // Drain loop: take → mark Busy → run handler (catching defects)
      // → mark Idle if queue is now empty. `Stream.fromQueue` ends
      // naturally when the queue is shut down (Scope finalizer below),
      // so the fiber returns cleanly without an explicit interrupt for
      // the happy path.
      const drainEffect: Effect.Effect<void, never> = Stream.fromQueue(
        queue,
      ).pipe(
        Stream.runForEach((request) =>
          Effect.gen(function* () {
            MutableRef.set(idleSince, { _tag: "Busy" } as const);
            yield* config.handle(request).pipe(
              Effect.catchAllCause((cause) =>
                Effect.sync(() => {
                  config.logger?.warn(
                    `appCallback partition worker handler defected (key=${config.key})`,
                    Cause.pretty(cause),
                  );
                }),
              ),
            );
            const remaining = yield* Queue.size(queue).pipe(
              Effect.catchAllCause(() => Effect.succeed(0)),
            );
            if (remaining === 0) {
              MutableRef.set(idleSince, {
                _tag: "Idle",
                sinceMs: clock(),
              } as const);
            }
          }),
        ),
        Effect.catchAllCause((cause) =>
          Effect.sync(() => {
            config.logger?.warn(
              `appCallback partition worker fiber exited (key=${config.key})`,
              Cause.pretty(cause),
            );
          }),
        ),
        Effect.asVoid,
      );
      const fiber = yield* Effect.forkScoped(drainEffect);

      // Shut the queue when the worker scope closes. `Effect.forkScoped`
      // already covers fiber interruption; queue.shutdown is the
      // belt-and-braces guarantee that the running stream observes the
      // shutdown and returns even if the fiber is mid-handler.
      yield* Effect.addFinalizer(() =>
        Queue.shutdown(queue).pipe(Effect.catchAllCause(() => Effect.void)),
      );

      const offer = (
        request: PartitionableRequest,
      ): Effect.Effect<void, PartitionQueueFullError> =>
        Effect.gen(function* () {
          const size = yield* Queue.size(queue).pipe(
            // `Queue.size` on a shut-down queue surfaces interrupt; treat
            // every failure as "queue unavailable" → full-error tag.
            Effect.catchAllCause(() => Effect.succeed(config.capacity)),
          );
          if (size >= config.capacity) {
            return yield* Effect.fail(
              new PartitionQueueFullError({
                key: config.key,
                capacity: config.capacity,
                requestId: request.id,
              }),
            );
          }
          // Atomic CAS: transition Idle/Busy → Busy, but refuse if the
          // dispatcher's reaper has already claimed this worker for
          // teardown (`Retiring`). The reaper sets `Retiring`
          // synchronously inside its `Ref.modify(partitionsRef, …)`
          // lambda, so once we observe `Retiring` here, the worker has
          // already been removed from the partition map and its scope
          // is being closed. Failing without enqueueing is the correct
          // and only safe move — a queued item would be silently
          // dropped when `Scope.close` fires `Queue.shutdown`.
          const claim = MutableRef.updateAndGet(idleSince, (current) =>
            current._tag === "Retiring" ? current : ({ _tag: "Busy" } as const),
          );
          if (claim._tag === "Retiring") {
            return yield* Effect.fail(
              new PartitionQueueFullError({
                key: config.key,
                capacity: config.capacity,
                requestId: request.id,
              }),
            );
          }
          const accepted = yield* Queue.offer(queue, request).pipe(
            Effect.catchAllCause(() => Effect.succeed(false)),
          );
          if (!accepted) {
            // Queue shut down between size-check and offer — surface as
            // `PartitionQueueFullError` so the reader's tag-discrimination
            // path treats it identically to "queue full".
            return yield* Effect.fail(
              new PartitionQueueFullError({
                key: config.key,
                capacity: config.capacity,
                requestId: request.id,
              }),
            );
          }
        });

      return {
        key: config.key,
        offer,
        fiber,
        idleSince,
        queueSize: Queue.size(queue).pipe(
          Effect.catchAllCause(() => Effect.succeed(0)),
        ),
        scope: config.scope,
      } satisfies PartitionWorker;
    }),
    config.scope,
  );
}
