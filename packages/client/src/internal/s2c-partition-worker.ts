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
 *
 * Single-producer guarantee: only the dispatcher's reader-fiber path
 * calls `offer` for any given partition. That makes the
 * `Queue.size + offer` pre-check race-free for "full" detection: if
 * size < capacity at the check, the subsequent `offer` cannot suspend
 * because no other producer can fill the queue between check and
 * offer. The drain fiber only consumes; it cannot push us past
 * capacity.
 */
import { Cause, Effect, Fiber, Queue, Ref, Scope, Stream } from "effect";
import { PartitionQueueFullError } from "./s2c-dispatcher-errors.js";
import type {
  PartitionKey,
  PartitionableRequest,
} from "./s2c-partition-key.js";
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

/** Idle / busy sum-type tracked per worker. See `PartitionWorker.idleSince`. */
export type IdleSince =
  | { readonly _tag: "Idle"; readonly sinceMs: number }
  | { readonly _tag: "Busy" };

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
   * Idle-since tracker. `Busy` while the worker has a request queued
   * or a handler running; `Idle{sinceMs}` once the queue drains and
   * the handler returns. The dispatcher's idle reaper compares
   * `Idle.sinceMs` against `now - idlePartitionTtlMs` to decide
   * retirement.
   */
  readonly idleSince: Ref.Ref<IdleSince>;
  /**
   * Live queue size for `DispatcherStats`. Reaper does not consult
   * this — it gates strictly on `idleSince._tag === "Idle"` to avoid
   * races where the queue snapshot misses an in-flight item.
   */
  readonly queueSize: Effect.Effect<number>;
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
  /** Monotonic clock for tests; defaults to `Date.now`. */
  readonly clock?: () => number;
}

/**
 * Build one worker. Allocates a bounded queue, forks a draining fiber
 * via `Stream.fromQueue` + `Stream.runForEach`, and registers the
 * scope finalizer that shuts the queue. Defects in `handle` are
 * caught + logged; the fiber never fails.
 */
export function makePartitionWorker(
  config: PartitionWorkerConfig,
): Effect.Effect<PartitionWorker, never, Scope.Scope> {
  const clock = config.clock ?? Date.now;
  return Effect.gen(function* () {
    const queue = yield* Queue.bounded<PartitionableRequest>(config.capacity);
    const idleSince = yield* Ref.make<IdleSince>({
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
          yield* Ref.set(idleSince, { _tag: "Busy" } as const);
          yield* config.handle(request).pipe(
            Effect.catchAllCause((cause) =>
              Effect.sync(() => {
                config.logger?.warn(
                  `s2c partition worker handler defected (key=${config.key})`,
                  Cause.pretty(cause),
                );
              }),
            ),
          );
          const remaining = yield* Queue.size(queue).pipe(
            Effect.catchAllCause(() => Effect.succeed(0)),
          );
          if (remaining === 0) {
            yield* Ref.set(idleSince, {
              _tag: "Idle",
              sinceMs: clock(),
            } as const);
          }
        }),
      ),
      Effect.catchAllCause((cause) =>
        Effect.sync(() => {
          config.logger?.warn(
            `s2c partition worker fiber exited (key=${config.key})`,
            Cause.pretty(cause),
          );
        }),
      ),
      Effect.asVoid,
    );
    const fiber = yield* Effect.forkScoped(drainEffect);

    // Shut the queue when the dispatcher Scope closes. `Effect.forkScoped`
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
        // Mark Busy BEFORE offer so any reaper tick that observes
        // mid-offer state cannot finalize this partition between
        // size-check and drain start.
        yield* Ref.set(idleSince, { _tag: "Busy" } as const);
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
    } satisfies PartitionWorker;
  });
}
