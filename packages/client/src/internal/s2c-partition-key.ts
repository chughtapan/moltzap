/**
 * Pure partition-key extractor for the partitioned s2c dispatcher.
 *
 * Spec: moltzap#356.
 *
 * Decode rules — `decodeFrames` validates the **frame envelope only**
 * (`packages/client/src/runtime/frame.ts:29-34@f0df363`); the inbound
 * `params` field arrives as `unknown`. Per-method param-shape decode
 * (`S2cRpcMap[method]['params']`) is the AppHost layer's job
 * (`packages/app-sdk/src/app.ts:489-491@f0df363`) and is unchanged
 * by this refactor.
 *
 * This module performs **narrow validation of routing fields only**:
 * confirm `params` is an object, then extract three fields with
 * the same tolerance as the AppHost cast:
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
import { Brand, Data, Either } from "effect";
import { MalformedPartitionKeyError } from "./s2c-dispatcher-errors.js";

import {
  AppsOnBeforeDispatch,
  AppsOnBeforeMessageDelivery,
  AppsOnClose,
  AppsOnJoin,
  AppsOnSessionActive,
} from "@moltzap/protocol";

/**
 * Branded partition-key string. Constructed only by `extractPartitionKey`.
 * Format is opaque to consumers; equality is value equality.
 */
export type PartitionKey = string & Brand.Brand<"PartitionKey">;
export const PartitionKey = Brand.nominal<PartitionKey>();

export class PartitionKeyInvariantError extends Data.TaggedError(
  "PartitionKeyInvariantError",
)<{
  readonly key: PartitionKey;
  readonly message: string;
}> {}

/**
 * Sentinel placeholder for s2c methods that carry no `conversationId`
 * (lifecycle: `apps/onJoin`, `apps/onClose`, `apps/onSessionActive`).
 * All lifecycle calls for the same `(sessionId, method)` share one
 * partition; cross-method lifecycle ordering is preserved by the server,
 * not the client.
 */
export const LIFECYCLE_CONVERSATION_SENTINEL = "*lifecycle*" as const;

/**
 * Methods that carry `conversationId` on `params`. Disjoint from the
 * lifecycle methods, which fall back to `LIFECYCLE_CONVERSATION_SENTINEL`.
 *
 * Kept as a literal `Set` (not derived from `s2cRpcMethods`) so this
 * module has no schema-package import beyond the error type — keeping
 * the routing layer pure and import-cycle-free per architect §3.2.
 */
const CONVERSATION_BEARING_METHODS = new Set<string>([
  AppsOnBeforeDispatch.name,
  AppsOnBeforeMessageDelivery.name,
]);

const LIFECYCLE_METHODS = new Set<string>([
  AppsOnJoin.name,
  AppsOnClose.name,
  AppsOnSessionActive.name,
]);

/**
 * Field separator inside a `PartitionKey`. ASCII vertical bar; not legal
 * in a UUID and not legal in any of our `appId` values, so the encoded
 * key parses unambiguously.
 */
const KEY_SEP = "|";

/**
 * Shape the dispatcher hands the extractor. Mirrors `DecodedServerRequest`
 * in `ws-client.ts` but stays import-cycle-free for the internal modules.
 */
export interface PartitionableRequest {
  readonly id: string;
  readonly method: string;
  readonly params: unknown;
  readonly traceparent?: string;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
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
  const { id: requestId, method, params } = request;

  const isLifecycle = LIFECYCLE_METHODS.has(method);
  const isConversationBearing = CONVERSATION_BEARING_METHODS.has(method);
  if (!isLifecycle && !isConversationBearing) {
    return Either.left(
      new MalformedPartitionKeyError({
        method,
        reason: "unknown-method",
        requestId,
      }),
    );
  }

  if (!isPlainObject(params)) {
    return Either.left(
      new MalformedPartitionKeyError({
        method,
        reason: "params-shape",
        requestId,
      }),
    );
  }

  const sessionIdRaw = params["sessionId"];
  if (typeof sessionIdRaw !== "string" || sessionIdRaw.length === 0) {
    return Either.left(
      new MalformedPartitionKeyError({
        method,
        reason: "missing-session-id",
        requestId,
      }),
    );
  }

  let conversationId: string;
  if (isConversationBearing) {
    const convRaw = params["conversationId"];
    if (typeof convRaw !== "string" || convRaw.length === 0) {
      return Either.left(
        new MalformedPartitionKeyError({
          method,
          reason: "missing-conversation-id",
          requestId,
        }),
      );
    }
    conversationId = convRaw;
  } else {
    // Lifecycle: synthesize sentinel. (S, "*lifecycle*", method) keeps
    // distinct lifecycle methods on distinct keys per OQ-1 default.
    conversationId = LIFECYCLE_CONVERSATION_SENTINEL;
  }

  return Either.right(
    PartitionKey(
      `${sessionIdRaw}${KEY_SEP}${conversationId}${KEY_SEP}${method}`,
    ),
  );
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
  // Method is the only field that can contain a slash; sessionId is a
  // UUID and conversationId is a UUID or the lifecycle sentinel. Split
  // on the first two `KEY_SEP` occurrences only so a hypothetical
  // future method name with `KEY_SEP` (impossible today; ASCII `|`)
  // would still round-trip cleanly.
  const first = key.indexOf(KEY_SEP);
  const second = first === -1 ? -1 : key.indexOf(KEY_SEP, first + 1);
  if (first === -1 || second === -1) {
    // `extractPartitionKey` is the only constructor; an unparsable key
    // means a caller bypassed branding. This is a programmer error,
    // not a runtime user-input failure — fail loudly.
    throw new PartitionKeyInvariantError({
      key,
      message: `describePartitionKey: malformed PartitionKey: ${key}`,
    });
  }
  return {
    sessionId: key.slice(0, first),
    conversationId: key.slice(first + 1, second),
    method: key.slice(second + 1),
  };
}
