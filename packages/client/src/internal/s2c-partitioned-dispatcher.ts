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
 * async (queue.shutdown + fiber.interrupt yield through the runtime),
 * breaking the regression gate at `packages/client/src/ws-client.test.ts:1233-1259`.
 * The `runSync(client.close())` contract is load-bearing — see the
 * test commentary there.
 *
 * Worker scopes are children of the dispatcher Scope (worker
 * construction calls `Scope.extend` against the dispatcher Scope).
 * Closing the dispatcher Scope cascades to every worker.
 */
import { Effect, Scope } from "effect";
import type {
  MalformedPartitionKeyError,
  OfferRejected,
  PartitionLimitError,
  PartitionQueueFullError,
} from "./s2c-dispatcher-errors.js";
import type { PartitionKey, PartitionableRequest } from "./s2c-partition-key.js";
import type {
  PartitionHandler,
  PartitionWorker,
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
   * interrupt are async); calling `runSync` on it would throw
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
 */
export interface MakePartitionedDispatcherParams {
  readonly handle: PartitionHandler;
  readonly config?: Partial<PartitionedDispatcherConfig>;
  readonly logger?: WsClientLogger;
}

/**
 * Construct a partitioned dispatcher. Returns scoped — the caller's
 * `Scope` owns every per-partition fiber and the idle-reaper fiber.
 */
export function makePartitionedDispatcher(
  params: MakePartitionedDispatcherParams,
): Effect.Effect<PartitionedDispatcher, never, Scope.Scope> {
  throw new Error("not implemented");
}

/**
 * Internal helper exported for unit testing. Allocates a worker for
 * `key` if absent and returns it, or returns the existing worker.
 * Returns `PartitionLimitError` if creation would exceed
 * `maxPartitions` AND no idle partition is present to reclaim.
 *
 * NOT part of the public surface — the only public entry is `offer`.
 */
export function getOrCreatePartitionWorker(
  params: {
    readonly key: PartitionKey;
    readonly requestId: string;
    readonly handle: PartitionHandler;
    readonly config: PartitionedDispatcherConfig;
    readonly logger?: WsClientLogger;
    /** The partition-map ref the dispatcher closes over. Opaque to callers. */
    readonly state: unknown;
  },
): Effect.Effect<PartitionWorker, PartitionLimitError, Scope.Scope> {
  throw new Error("not implemented");
}
