/**
 * Tagged error types for the partitioned s2c dispatcher.
 *
 * Spec: moltzap#356 — partitioned dispatch keyed on
 * `(sessionId, conversationId, hookKind)`.
 *
 * All errors are surfaced on `PartitionedDispatcher.offer`'s typed channel.
 * The reader fiber translates each tag into an immediate s2c error response
 * so the server's `Deferred.await` resolves deterministically (no hangs).
 */
import { Data } from "effect";

/**
 * The decoded server-request frame did not carry a usable partition key.
 * Examples: required `params.sessionId` missing or not a UUID; method
 * name absent from the s2c registry.
 *
 * Failure mode is structural — the request cannot be routed. The reader
 * synthesizes a `-32602 Invalid params` error response.
 */
export class MalformedPartitionKeyError extends Data.TaggedError(
  "MalformedPartitionKeyError",
)<{
  readonly method: string;
  readonly reason: "missing-session-id" | "missing-conversation-id" | "unknown-method" | "params-shape";
  readonly requestId: string;
}> {}

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
export class PartitionLimitError extends Data.TaggedError("PartitionLimitError")<{
  readonly key: string;
  readonly activePartitions: number;
  readonly maxPartitions: number;
  readonly requestId: string;
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
  readonly requestId: string;
}> {}

/**
 * Discriminated union over every reason `PartitionedDispatcher.offer` can
 * reject an inbound request. Exhaustive: adding a new branch fails every
 * `match` site at compile time. Branch handlers in the reader's
 * frame-routing path discriminate on `_tag` to pick the right wire-error
 * code.
 */
export type OfferRejected =
  | MalformedPartitionKeyError
  | PartitionLimitError
  | PartitionQueueFullError;
