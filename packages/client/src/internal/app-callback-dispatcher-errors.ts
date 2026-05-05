/**
 * Tagged error types for the partitioned appCallback dispatcher.
 *
 * Spec: moltzap#356 — partitioned dispatch keyed on
 * `(taskId, conversationId, hookKind)`.
 *
 * All errors are surfaced on `PartitionedDispatcher.offer`'s typed channel.
 * The reader fiber translates each tag into an immediate appCallback error response
 * so the server's `Deferred.await` resolves deterministically (no hangs).
 */
import { Data } from "effect";
import type { JsonRpcStringId } from "@moltzap/protocol";

/**
 * The active-partition count has reached `maxPartitions` (soft cap, default
 * 256). New partitions cannot be allocated until an existing partition is
 * reaped by the idle reaper or the connection scope closes. Per-tenant DoS
 * guard.
 *
 * Failure mode is liveness — the request is rejected without contention
 * with existing partitions. Reader synthesizes a `-32000 Server busy`
 * error response so the server retries / falls through.
 */
export class PartitionLimitError extends Data.TaggedError(
  "PartitionLimitError",
)<{
  readonly key: string;
  readonly activePartitions: number;
  readonly maxPartitions: number;
  readonly requestId: JsonRpcStringId;
}> {}

/**
 * The target partition's bounded queue is at capacity (default 32). Slow
 * handler is backpressuring its own partition. Other partitions are
 * unaffected.
 *
 * Failure mode is per-partition liveness — the queue is full ONLY for this
 * tuple. Reader synthesizes a `-32000 Partition busy` error response;
 * server may retry or surface the failure to the originator (AppHost
 * fail-CLOSED verdict for hooks).
 */
export class PartitionQueueFullError extends Data.TaggedError(
  "PartitionQueueFullError",
)<{
  readonly key: string;
  readonly capacity: number;
  readonly requestId: JsonRpcStringId;
}> {}

/**
 * Discriminated union over every reason `PartitionedDispatcher.offer` can
 * reject an inbound request. Exhaustive: adding a new branch fails every
 * `match` site at compile time. Branch handlers in the reader's
 * frame-routing path discriminate on `_tag` to pick the right wire-error
 * code.
 */
export type OfferRejected = PartitionLimitError | PartitionQueueFullError;
