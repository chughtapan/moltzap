/**
 * Pure partition-key extractor for the partitioned s2c dispatcher.
 *
 * Spec: moltzap#356.
 *
 * Decode rules — keys are extracted from already-decoded params (schema
 * runs at the wire boundary inside `decodeFrames`); this module performs
 * NO further schema decode. It reads three fields:
 *
 *   - `sessionId` (always required for every entry in `s2cRpcMethods`)
 *   - `conversationId` (present on `apps/onBeforeDispatch` and
 *     `apps/onBeforeMessageDelivery`; absent on lifecycle methods —
 *     synthesized as the literal sentinel `*lifecycle*`)
 *   - `method` — the wire method name doubles as `hookKind`.
 *
 * The result is a branded string `PartitionKey`. Branding prevents
 * accidental reuse of raw `string` keys in the worker map.
 */
import { Either } from "effect";
import { MalformedPartitionKeyError } from "./s2c-dispatcher-errors.js";

/**
 * Branded partition-key string. Constructed only by `extractPartitionKey`.
 * Format is opaque to consumers; equality is value equality.
 */
export type PartitionKey = string & { readonly __brand: "PartitionKey" };

/**
 * Sentinel placeholder for s2c methods that carry no `conversationId`
 * (lifecycle: `apps/onJoin`, `apps/onClose`, `apps/onSessionActive`).
 * All lifecycle calls for the same `(sessionId, method)` share one
 * partition; cross-method lifecycle ordering is preserved by the server,
 * not the client.
 */
export const LIFECYCLE_CONVERSATION_SENTINEL = "*lifecycle*" as const;

/**
 * Shape the dispatcher hands the extractor. Mirrors `DecodedServerRequest`
 * in `ws-client.ts` but stays import-cycle-free for the internal modules.
 */
export interface PartitionableRequest {
  readonly id: string;
  readonly method: string;
  readonly params: unknown;
}

/**
 * Decode a partition key from an inbound s2c request. Does NOT mutate the
 * request. On any structural failure, returns
 * `MalformedPartitionKeyError` with a typed `reason` tag the reader fiber
 * uses to pick an error response code.
 */
export function extractPartitionKey(
  request: PartitionableRequest,
): Either.Either<PartitionKey, MalformedPartitionKeyError> {
  throw new Error("not implemented");
}

/**
 * Inverse projection for tests + observability. Pure deconstruction of a
 * `PartitionKey` back into its three components. Returning a structured
 * record (rather than a tuple) lets callers discriminate on
 * `conversationId === LIFECYCLE_CONVERSATION_SENTINEL`.
 */
export function describePartitionKey(key: PartitionKey): {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly method: string;
} {
  throw new Error("not implemented");
}
