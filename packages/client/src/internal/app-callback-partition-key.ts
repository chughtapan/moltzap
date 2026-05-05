/**
 * Pure partition-key extractor for the partitioned appCallback dispatcher.
 *
 * Spec: moltzap#356.
 *
 * `decodeFrames` is the wire boundary. It matches the JSON-RPC method to an
 * app-callback descriptor, validates params against that descriptor, and
 * projects the routing tuple. This module only receives that typed decoded
 * request and turns the tuple into an opaque branded `PartitionKey`.
 *
 * There is no malformed-input branch here: malformed app-callback frames are
 * rejected before a request can enter the dispatcher.
 */
import { Brand, Data } from "effect";

import {
  type AnyTaskCallbackRpcDefinition,
  type DecodedRpcRequest,
  type JsonRpcStringId,
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
 * Field separator inside a `PartitionKey`. ASCII vertical bar; not legal
 * in a UUID and not legal in any of our `appId` values, so the encoded
 * key parses unambiguously.
 */
const KEY_SEP = "|";
const definitionSegments = new WeakMap<AnyTaskCallbackRpcDefinition, string>();
const definitionsBySegment = new Map<string, AnyTaskCallbackRpcDefinition>();
let nextDefinitionSegment = 0;

const segmentForDefinition = (
  definition: AnyTaskCallbackRpcDefinition,
): string => {
  const existing = definitionSegments.get(definition);
  if (existing !== undefined) return existing;
  const segment = `rpc${nextDefinitionSegment}`;
  nextDefinitionSegment += 1;
  definitionSegments.set(definition, segment);
  definitionsBySegment.set(segment, definition);
  return segment;
};

export interface AppCallbackPartitionRoute {
  readonly taskId: string;
  readonly conversationId: string;
}

/**
 * Shape the dispatcher receives after the wire decoder has matched an
 * app-callback descriptor and validated params against that descriptor.
 */
export type PartitionableRequest =
  DecodedRpcRequest<AnyTaskCallbackRpcDefinition> & {
    readonly id: JsonRpcStringId;
    readonly partition: AppCallbackPartitionRoute;
  };

/**
 * Project a partition key from a typed appCallback request. The wire decoder
 * has already validated method membership and params shape, so this function
 * has no malformed-input branch.
 */
export function extractPartitionKey(
  request: PartitionableRequest,
): PartitionKey {
  return PartitionKey(
    `${request.partition.taskId}${KEY_SEP}${request.partition.conversationId}${KEY_SEP}${segmentForDefinition(request.definition)}`,
  );
}

/**
 * Inverse projection for tests + observability. Pure deconstruction of a
 * `PartitionKey` back into its three components.
 */
export function describePartitionKey(key: PartitionKey): {
  readonly taskId: string;
  readonly conversationId: string;
  readonly definition: AnyTaskCallbackRpcDefinition;
} {
  // Method is the only field that can contain a slash; taskId is a
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
  const definition = definitionsBySegment.get(key.slice(second + 1));
  if (definition === undefined) {
    throw new PartitionKeyInvariantError({
      key,
      message: `describePartitionKey: unknown descriptor segment: ${key}`,
    });
  }
  return {
    taskId: key.slice(0, first),
    conversationId: key.slice(first + 1, second),
    definition,
  };
}
