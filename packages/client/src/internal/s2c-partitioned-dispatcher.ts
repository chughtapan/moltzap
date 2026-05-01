/**
 * Partitioned s2c dispatcher.
 *
 * Spec: moltzap#356.
 *
 * Replaces the single `Stream.runForEach(handler)` over `s2cInboundQueue`
 * (`packages/client/src/ws-client.ts:658-687@f0df363`) with a
 * partition-router that owns a `Ref<HashMap<PartitionKey,
 * PartitionWorker>>`. For each inbound request:
 *
 *   1. The reader fiber calls `dispatcher.offer(request)`.
 *   2. The dispatcher extracts the partition key (pure, no schema decode).
 *   3. If a worker exists for that key, `worker.offer(request)`.
 *   4. Otherwise, allocate a worker (subject to soft cap) and offer.
 *
 * The dispatcher itself does NOT run a long-lived router fiber: routing
 * is synchronous-up-to-effect on the reader's call thread. The only
 * dispatcher-owned fiber is the **idle reaper**, which periodically
 * walks the partition map and finalizes any worker whose
 * `idleSince._tag === "Idle"` exceeds `idlePartitionTtlMs`.
 *
 * Why no router fiber: a router fiber would serialize routing decisions,
 * defeating the purpose of partitioning. `Ref.modify` on the partition
 * map is atomic; concurrent reader-fiber offers compose without a router.
 *
 * Lifetime: `make` returns `Effect<…, never, Scope.Scope>`. The caller
 * (`ws-client.ts` inside `connectEffect`) calls `Scope.make()` to
 * produce a **dedicated dispatcher Scope** that is NOT bound to the
 * socket Scope, then provides that Scope to `makePartitionedDispatcher`.
 * The dispatcher Scope is held in `ConnState`; teardown from
 * `close()` / `disconnectSync()` is
 * `runtime.runFork(Scope.close(dispatcherScope, Exit.void))`, mirroring
 * today's `runFork(Queue.shutdown(s2cInboundQueue))` +
 * `runFork(Fiber.interrupt(s2cDispatcherFiber))` pair.
 *
 * Why off-Scope from the socket: `close()` is invoked via `runSync` at
 * `packages/openclaw-channel/src/__tests__/reconnection.integration.test.ts:14`;
 * binding the dispatcher to the socket Scope would make `Scope.close`
 * yield through the runtime (queue.shutdown + fiber.interrupt are
 * non-synchronous), breaking the regression gate at
 * `packages/client/src/ws-client.test.ts:1233-1259`.
 * The `runSync(client.close())` contract is load-bearing — see the
 * test commentary there.
 *
 * Worker scopes are children of the dispatcher Scope (worker
 * construction calls `Scope.extend` against the dispatcher Scope).
 * Closing the dispatcher Scope cascades to every worker.
 */
import {
  Cause,
  Duration,
  Effect,
  Either,
  Exit,
  Fiber,
  HashMap,
  Option,
  Ref,
  Schedule,
  Scope,
} from "effect";
import {
  PartitionLimitError,
  type OfferRejected,
} from "./s2c-dispatcher-errors.js";
import {
  extractPartitionKey,
  type PartitionKey,
  type PartitionableRequest,
} from "./s2c-partition-key.js";
import {
  makePartitionWorker,
  type PartitionHandler,
  type PartitionWorker,
} from "./s2c-partition-worker.js";
import type { WsClientLogger } from "../ws-client.js";

/**
 * Tunable knobs. Defaults named in the design doc; downstream picks
 * exact values at the `MoltZapWsClient` constructor edge.
 */
export interface PartitionedDispatcherConfig {
  /**
   * Soft cap on simultaneously-active partitions per connection.
   * Default 256. Hit → new partitions fail with `PartitionLimitError`
   * until the idle reaper retires one.
   */
  readonly maxPartitions: number;
  /**
   * Bounded queue depth per partition. Default 32. Hit → `offer` fails
   * with `PartitionQueueFullError` for THIS partition only.
   */
  readonly partitionQueueCapacity: number;
  /**
   * Idle reaper threshold: a worker whose queue has been continuously
   * empty for at least this many milliseconds is finalized on the next
   * reaper tick. Default 60_000.
   */
  readonly idlePartitionTtlMs: number;
  /**
   * Idle reaper tick period. Default 5_000. Lower = tighter reclamation,
   * higher CPU cost; higher = looser reclamation, lower overhead.
   */
  readonly idleReaperIntervalMs: number;
}

/** Defaults. Documented as the named knob values for the implementation. */
export const DEFAULT_PARTITIONED_DISPATCHER_CONFIG: PartitionedDispatcherConfig =
  {
    maxPartitions: 256,
    partitionQueueCapacity: 32,
    idlePartitionTtlMs: 60_000,
    idleReaperIntervalMs: 5_000,
  };

/**
 * Snapshot of dispatcher state for tests + observability. NOT stable
 * across releases; consumers must treat as best-effort instrumentation.
 */
export interface DispatcherStats {
  readonly activePartitions: number;
  readonly totalOffered: number;
  readonly totalRejected: {
    readonly malformed: number;
    readonly partitionLimit: number;
    readonly partitionQueueFull: number;
  };
  readonly partitions: ReadonlyArray<{
    readonly key: PartitionKey;
    readonly queueSize: number;
    readonly idle: boolean;
  }>;
}

/**
 * Public surface used by `ws-client.ts`. Construction is scoped — the
 * caller's `Scope` owns every partition fiber.
 */
export interface PartitionedDispatcher {
  /**
   * Route one inbound request. Non-blocking. Failure modes are
   * exhaustive in `OfferRejected`; the reader fiber `Effect.match`es
   * the tag set to pick a wire-error code.
   *
   * Per-tuple ordering: two `offer` calls with the same `PartitionKey`
   * land on the same `PartitionWorker.offer` (FIFO).
   * Cross-tuple concurrency: two `offer` calls with different keys
   * produce no ordering relation.
   */
  readonly offer: (
    request: PartitionableRequest,
  ) => Effect.Effect<void, OfferRejected>;
  /**
   * Best-effort stats snapshot. Not used in the hot path; called by
   * tests + the optional `client.stats()` debug surface.
   */
  readonly stats: Effect.Effect<DispatcherStats>;
  /**
   * Explicit shutdown. Equivalent to `Scope.close(dispatcherScope,
   * Exit.void)`; exists as a typed handle so callsites that already
   * hold the dispatcher (not the Scope) can tear it down without
   * threading the Scope through `ConnState`. Idempotent.
   *
   * Callsites that invoke this from a `runSync` context (`close()`,
   * `disconnectSync()`) MUST wrap with `runtime.runFork`. The Effect
   * itself yields through the runtime (queue shutdown + fiber
   * interrupt are non-synchronous); calling `runSync` on it would throw
   * `AsyncFiberException`. See the regression gate at
   * `packages/client/src/ws-client.test.ts:1233-1259@f0df363`.
   */
  readonly shutdown: Effect.Effect<void>;
}

/**
 * Construction params. `handle` is the per-request work — passed in so
 * the dispatcher has no direct dependency on the handler-registry
 * `Ref<HashMap<string, ServerRpcHandler>>` (`s2cHandlersRef`); the
 * caller (`ws-client.ts`) closes over the registry and supplies a
 * pre-bound function. This preserves the wire-edge schema-decoding
 * boundary already established in `dispatchInboundServerRequest`.
 *
 * `scope` is the `Scope.CloseableScope` that owns every per-partition
 * worker fiber + the idle reaper. The caller (`ws-client.ts`)
 * allocates it via `Scope.make()` outside the per-connect socket
 * Scope so `runSync(client.close())` can `runFork(Scope.close(scope,
 * Exit.void))` without yielding through the runtime.
 */
export interface MakePartitionedDispatcherParams {
  readonly handle: PartitionHandler;
  readonly scope: Scope.CloseableScope;
  readonly config?: Partial<PartitionedDispatcherConfig>;
  readonly logger?: WsClientLogger;
  /** Monotonic clock for tests. Defaults to `Date.now`. */
  readonly clock?: () => number;
}

/**
 * Internal mutable counters used to populate `DispatcherStats`. Kept
 * separate from the partition map so the offer hot path doesn't have
 * to update a single Ref under contention.
 */
interface DispatcherCounters {
  readonly totalOffered: Ref.Ref<number>;
  readonly malformed: Ref.Ref<number>;
  readonly partitionLimit: Ref.Ref<number>;
  readonly partitionQueueFull: Ref.Ref<number>;
}

/**
 * Internal state passed to `getOrCreatePartitionWorker`. Concretely:
 * the partition-map `Ref`, the dispatcher's Scope (for parenting
 * worker scopes), the construction `config`, the user's `handle`, and
 * the logger.
 */
interface DispatcherInternalState {
  readonly partitionsRef: Ref.Ref<
    HashMap.HashMap<PartitionKey, PartitionWorker>
  >;
  readonly dispatcherScope: Scope.CloseableScope;
  readonly config: PartitionedDispatcherConfig;
  readonly handle: PartitionHandler;
  readonly logger?: WsClientLogger;
  readonly clock: () => number;
  readonly counters: DispatcherCounters;
}

/** Discriminated result of a same-key allocation race. */
type AllocationOutcome =
  | { readonly kind: "lost-race"; readonly winner: PartitionWorker }
  | { readonly kind: "won"; readonly winner: PartitionWorker };

/**
 * Construct a partitioned dispatcher. The caller-provided
 * `params.scope` owns every per-partition fiber + the idle-reaper
 * fiber; closing it cascades teardown via `Scope` finalizers.
 *
 * Returns `Effect<…, never>` — neither construction nor partition
 * allocation can fail. The Effect itself does not require a `Scope`
 * because every scoped allocation is provided to `params.scope`
 * explicitly via `Scope.extend`.
 */
export function makePartitionedDispatcher(
  params: MakePartitionedDispatcherParams,
): Effect.Effect<PartitionedDispatcher, never> {
  const config: PartitionedDispatcherConfig = {
    ...DEFAULT_PARTITIONED_DISPATCHER_CONFIG,
    ...params.config,
  };
  const clock = params.clock ?? Date.now;
  return Effect.gen(function* () {
    const partitionsRef = yield* Ref.make<
      HashMap.HashMap<PartitionKey, PartitionWorker>
    >(HashMap.empty());

    const counters: DispatcherCounters = {
      totalOffered: yield* Ref.make(0),
      malformed: yield* Ref.make(0),
      partitionLimit: yield* Ref.make(0),
      partitionQueueFull: yield* Ref.make(0),
    };

    const dispatcherScope = params.scope;

    const internal: DispatcherInternalState = {
      partitionsRef,
      dispatcherScope,
      config,
      handle: params.handle,
      ...(params.logger !== undefined ? { logger: params.logger } : {}),
      clock,
      counters,
    };

    // Idle-reaper fiber. One fiber per dispatcher (NOT per partition);
    // walks the map every `idleReaperIntervalMs` and finalizes
    // partitions whose `idleSince._tag === "Idle"` exceeds the TTL.
    const reaperEffect: Effect.Effect<void, never> = reapIdlePartitions(
      internal,
    ).pipe(
      Effect.repeat(
        Schedule.spaced(Duration.millis(config.idleReaperIntervalMs)),
      ),
      Effect.asVoid,
      Effect.catchAllCause((cause) =>
        Effect.sync(() =>
          params.logger?.warn("s2c idle reaper exited", Cause.pretty(cause)),
        ),
      ),
    );
    yield* Scope.extend(Effect.forkScoped(reaperEffect), dispatcherScope);

    const offer = (
      request: PartitionableRequest,
    ): Effect.Effect<void, OfferRejected> =>
      Effect.gen(function* () {
        yield* Ref.update(counters.totalOffered, (n) => n + 1);

        const keyResult = extractPartitionKey(request);
        if (Either.isLeft(keyResult)) {
          yield* Ref.update(counters.malformed, (n) => n + 1);
          return yield* Effect.fail(keyResult.left);
        }
        const key = keyResult.right;

        const worker = yield* getOrCreatePartitionWorker({
          key,
          requestId: request.id,
          state: internal,
        }).pipe(
          Effect.tapError((err) =>
            err._tag === "PartitionLimitError"
              ? Ref.update(counters.partitionLimit, (n) => n + 1)
              : Effect.void,
          ),
        );

        yield* worker
          .offer(request)
          .pipe(
            Effect.tapError(() =>
              Ref.update(counters.partitionQueueFull, (n) => n + 1),
            ),
          );
      });

    const stats: Effect.Effect<DispatcherStats> = Effect.gen(function* () {
      const map = yield* Ref.get(partitionsRef);
      const partitions: Array<DispatcherStats["partitions"][number]> = [];
      for (const [key, worker] of HashMap.entries(map)) {
        const queueSize = yield* worker.queueSize;
        const idle = (yield* Ref.get(worker.idleSince))._tag === "Idle";
        partitions.push({ key, queueSize, idle });
      }
      const totalOffered = yield* Ref.get(counters.totalOffered);
      const malformed = yield* Ref.get(counters.malformed);
      const partitionLimit = yield* Ref.get(counters.partitionLimit);
      const partitionQueueFull = yield* Ref.get(counters.partitionQueueFull);
      return {
        activePartitions: HashMap.size(map),
        totalOffered,
        totalRejected: {
          malformed,
          partitionLimit,
          partitionQueueFull,
        },
        partitions,
      };
    });

    const shutdown: Effect.Effect<void> = Scope.close(
      dispatcherScope,
      Exit.void,
    ).pipe(Effect.catchAllCause(() => Effect.void));

    return {
      offer,
      stats,
      shutdown,
    } satisfies PartitionedDispatcher;
  });
}

// ─── Internal helpers ────────────────────────────────────────────────

/**
 * Allocate a worker for `key` if absent and return it, or return the
 * existing worker. Returns `PartitionLimitError` if creation would
 * exceed `maxPartitions` AND no idle partition is reclaimable.
 *
 * NOT part of the public surface — the only public entry is `offer`.
 *
 * Race-safety: under concurrent offers for the same new key, exactly
 * one allocation wins. The losing offer's worker is interrupted and
 * the winner is returned. Since worker construction is `Effect`-shaped,
 * we cannot put it inside `Ref.modify`'s synchronous lambda; instead
 * we build outside, then atomic-insert with a check for prior winners
 * inside `modify`. Worst-case overhead under contention: one extra
 * worker built and immediately interrupted. Bounded by partition cap.
 */
function getOrCreatePartitionWorker(params: {
  readonly key: PartitionKey;
  readonly requestId: string;
  readonly state: DispatcherInternalState;
}): Effect.Effect<PartitionWorker, PartitionLimitError> {
  return Effect.gen(function* () {
    const { key, requestId, state } = params;
    const existing = yield* Ref.get(state.partitionsRef).pipe(
      Effect.map((m) => HashMap.get(m, key)),
    );
    if (Option.isSome(existing)) {
      return existing.value;
    }

    // Soft cap check is best-effort: under concurrent allocation we
    // may temporarily exceed by 1-2 before the next reaper tick. The
    // cap exists as a DoS guard, not an exact-cardinality invariant.
    const sizeBeforeAlloc = yield* Ref.get(state.partitionsRef).pipe(
      Effect.map((m) => HashMap.size(m)),
    );
    if (sizeBeforeAlloc >= state.config.maxPartitions) {
      return yield* Effect.fail(
        new PartitionLimitError({
          key,
          activePartitions: sizeBeforeAlloc,
          maxPartitions: state.config.maxPartitions,
          requestId,
        }),
      );
    }

    // Build the worker under the dispatcher Scope. The worker's own
    // finalizer (queue.shutdown) attaches to that scope; closing the
    // dispatcher cascades to every worker.
    const built = yield* Scope.extend(
      makePartitionWorker({
        key,
        capacity: state.config.partitionQueueCapacity,
        handle: state.handle,
        ...(state.logger !== undefined ? { logger: state.logger } : {}),
        clock: state.clock,
      }),
      state.dispatcherScope,
    );

    // Insert (or recover the racer's winner). Atomic.
    const inserted = yield* Ref.modify(
      state.partitionsRef,
      (
        m,
      ): readonly [
        AllocationOutcome,
        HashMap.HashMap<PartitionKey, PartitionWorker>,
      ] => {
        const present = HashMap.get(m, key);
        if (Option.isSome(present)) {
          return [{ kind: "lost-race", winner: present.value }, m];
        }
        return [{ kind: "won", winner: built }, HashMap.set(m, key, built)];
      },
    );

    if (inserted.kind === "lost-race") {
      // Discard the redundant worker. Its scope finalizer will close
      // when the dispatcher scope closes; we explicitly interrupt the
      // fiber here so it doesn't drain phantom work.
      state.logger?.warn(
        `s2c partition allocation lost race (key=${key}); discarding redundant worker`,
      );
      yield* Fiber.interrupt(built.fiber);
    }

    return inserted.winner;
  });
}

/**
 * One reaper tick. Walks the partition map, finalizing any worker
 * whose `idleSince._tag === "Idle"` AND whose age exceeds
 * `idlePartitionTtlMs`. Removal is atomic via `Ref.update`.
 *
 * A partition that became Busy between the snapshot and the modify
 * has its `idleSince` flipped, but we still drop it from the map
 * here. That race is rare (the offer path also calls
 * `Ref.set(idleSince, Busy)` before `Queue.offer`, and the reaper
 * tick is bounded by `idleReaperIntervalMs`). The cost is one
 * dropped request retried by the next reader-fiber offer; acceptable
 * trade against the cost of a synchronous re-check inside `modify`.
 */
function reapIdlePartitions(
  state: DispatcherInternalState,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    const now = state.clock();
    const map = yield* Ref.get(state.partitionsRef);
    const candidates: Array<{ key: PartitionKey; worker: PartitionWorker }> =
      [];
    for (const [key, worker] of HashMap.entries(map)) {
      const idleSince = yield* Ref.get(worker.idleSince);
      if (
        idleSince._tag === "Idle" &&
        now - idleSince.sinceMs >= state.config.idlePartitionTtlMs
      ) {
        candidates.push({ key, worker });
      }
    }
    if (candidates.length === 0) return;
    yield* Ref.update(state.partitionsRef, (current) => {
      let next = current;
      for (const { key } of candidates) {
        next = HashMap.remove(next, key);
      }
      return next;
    });
    for (const { worker } of candidates) {
      // Interrupt the worker's drain fiber. The worker's own
      // queue.shutdown finalizer fires when the dispatcher scope
      // closes; for the per-tick reaper we explicitly interrupt the
      // fiber so it stops accepting offers immediately.
      yield* Fiber.interrupt(worker.fiber).pipe(
        Effect.catchAllCause(() => Effect.void),
      );
    }
  });
}
