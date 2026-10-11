/** @file Pure MCP item and consumer framing shared by native hosts and the daemon. */

import { Effect, JSONSchema, Schema } from "effect";
import { eventIdSchema } from "../../delivery/operations.js";
import { InboundItem } from "../../transport/collectives/inbound.js";
import { exactStruct } from "../../transport/wire/values.js";
import { HARNESS_CONSUMER_META_KEY, INBOX_ITEM_EVENT } from "../mcp/names.js";

const itemEventData = Schema.Union(
  exactStruct({ kind: Schema.Literal("item"), item: InboundItem }),
  exactStruct({
    kind: Schema.Literal("reference"),
    itemKind: Schema.Literal(
      "multicast",
      "collectiveRequest",
      "collectiveResult",
      "operationFailed",
    ),
    bytes: Schema.NonNegativeInt,
  }),
);

const itemEventSchema = Schema.Struct({
  eventId: eventIdSchema,
  name: Schema.Literal(INBOX_ITEM_EVENT),
  timestamp: Schema.String,
  data: itemEventData,
  cursor: Schema.optional(Schema.Null),
});

/** Maximum complete UTF-8 occurrence, shared by polling and webhook reception. */
export const maximumEventBytes = 256 * 1024;

const verificationSchema = Schema.Struct({
  type: Schema.Literal("verification"),
  challenge: Schema.String.pipe(Schema.maxLength(512)),
});

/** Verification and classified occurrences share one bounded native callback decoder. */
export const decodeWebhookMessage = Schema.decodeUnknown(
  Schema.parseJson(Schema.Union(verificationSchema, itemEventSchema)),
);

/** One inline or retained-reference occurrence, without any store authority. */
export type ItemEvent = typeof itemEventSchema.Type;

const consumerMetadataSchema = exactStruct({
  generation: Schema.UUID,
  release: Schema.optionalWith(Schema.Boolean, { exact: true }),
});
const metadataSchema = Schema.Struct({
  [HARNESS_CONSUMER_META_KEY]: Schema.optional(consumerMetadataSchema),
});
const pollResultSchema = Schema.Struct({
  events: Schema.Array(itemEventSchema),
  cursor: Schema.String,
  truncated: Schema.Boolean,
  hasMore: Schema.Boolean,
  nextPollMs: Schema.NonNegativeInt,
  _meta: Schema.Struct(
    { [HARNESS_CONSUMER_META_KEY]: consumerMetadataSchema },
    Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  ),
});

/** Receipt binding distinguishes consumer lifetimes without granting authority. */
export type ConsumerMetadata = typeof consumerMetadataSchema.Type;
/** Native results carry a required consumer binding alongside open protocol metadata. */
export type PollResult = typeof pollResultSchema.Type;

/** SDK bookkeeping may extend `_meta`; the MoltZap consumer payload remains closed. */
export const pollResultJsonSchema = JSONSchema.make(pollResultSchema, {
  target: "jsonSchema2020-12",
});

/**
 * Validates only MoltZap-owned metadata, leaving protocol bookkeeping to the SDK.
 * @param metadata Untrusted MCP request metadata, including SDK-owned fields.
 * @returns A consumer binding when supplied, or an explicit decoding failure.
 */
export const decodeConsumerMetadata = (metadata: unknown) =>
  Schema.decodeUnknown(metadataSchema)(metadata ?? {}).pipe(
    Effect.map((value) => value[HARNESS_CONSUMER_META_KEY]),
  );

/** Validates a native result at non-SDK diagnostics and fixture boundaries. */
export const decodePollResult = Schema.decodeUnknown(pollResultSchema);

/** The advertised event payload has the same inline/reference union for every mode. */
export const itemEventDataJsonSchema = JSONSchema.make(itemEventData, {
  target: "jsonSchema2020-12",
});
