/** @file MCP framing of the harness operations: tool names, send metadata, Events constants, and JSON Schema projections. */

import {
  Effect,
  JSONSchema,
  type ParseResult,
  Schema,
  type SchemaAST,
} from "effect";
import {
  harnessAcknowledgeDeliveryRequestSchema,
  harnessSendArgumentsSchema,
  harnessSendOptionsSchema,
  type HarnessSendRequest,
  harnessSendResultSchema,
  inboxRequestSchema,
  inboxResultSchema,
  readSendRequestSchema,
  readSendResultSchema,
} from "../../delivery/operations.js";
import { InboundItem } from "../../transport/collectives/inbound.js";
import { exactStruct } from "../../transport/wire/index.js";

/** A content-free wakeup to read the classified runtime inbox. */
export const INBOX_PENDING_EVENT = "moltzap.inbox.pending";

/** Classified content delivered directly to a webhook consumer. */
export const INBOX_ITEM_EVENT = "moltzap.inbox.item";

/** Semantic retrieval of content referenced by a large webhook event. */
export const HARNESS_READ_EVENT_TOOL = "read_event";

/** Adapter operation performing one collective operation. */
export const HARNESS_SEND_TOOL = "send_message";

/** Runtime send options travel outside model-generated tool arguments. */
export const HARNESS_SEND_META_KEY = "xyz.moltzap/send";

/** Retires an inbox item after its host-specific acceptance contract is met. */
export const HARNESS_ACKNOWLEDGE_DELIVERY_TOOL = "acknowledge_delivery";

/** Runtime read of classified deliveries whose host acceptance is pending. */
export const HARNESS_READ_INBOX_TOOL = "read_inbox";

/** Lookup of a retained invocation, distinct from collective completion. */
export const HARNESS_READ_SEND_TOOL = "read_send";

const exact: SchemaAST.ParseOptions = {
  exact: true,
  onExcessProperty: "error",
};

const exactEmptyObject = Schema.Record({
  key: Schema.String,
  value: Schema.Never,
}).annotations({ parseOptions: exact });

/** Inline content or an explicit reference without truncating stored content. */
const itemEventDataSchema = Schema.Union(
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

/** Classified webhook payload advertised through MCP event discovery. */
export const itemEventDataJsonSchema = JSONSchema.make(itemEventDataSchema, {
  target: "jsonSchema2020-12",
});

const harnessEmptyResultSchema = exactEmptyObject;

const harnessSendMetadataSchema = Schema.Struct({
  [HARNESS_SEND_META_KEY]: Schema.optionalWith(harnessSendOptionsSchema, {
    exact: true,
  }),
});

/** JSON Schema for the runtime inbox pagination arguments. */
export const harnessReadInboxRequestJsonSchema = JSONSchema.make(
  inboxRequestSchema,
  { target: "jsonSchema2020-12" },
);
/** JSON Schema for classified inbox pages. */
export const harnessReadInboxResultJsonSchema = JSONSchema.make(
  inboxResultSchema,
  { target: "jsonSchema2020-12" },
);
/** JSON Schema for keyed send lookup. */
export const harnessReadSendRequestJsonSchema = JSONSchema.make(
  readSendRequestSchema,
  { target: "jsonSchema2020-12" },
);
/** JSON Schema for observed send state. */
export const harnessReadSendResultJsonSchema = JSONSchema.make(
  readSendResultSchema,
  { target: "jsonSchema2020-12" },
);

/**
 * Validate semantic arguments separately from runtime-owned send options.
 * Unrelated SDK metadata belongs to the transport and is not interpreted here.
 * @param toolArguments Model-visible arguments.
 * @param metadata The SDK request metadata, if supplied.
 * @returns One validated invocation for the daemon's existing store.
 */
export function decodeHarnessSendCall(
  toolArguments: unknown,
  metadata: unknown,
): Effect.Effect<HarnessSendRequest, ParseResult.ParseError> {
  return Effect.gen(function* () {
    const args = yield* Schema.decodeUnknown(harnessSendArgumentsSchema)(
      toolArguments,
    );
    const runtime = yield* Schema.decodeUnknown(harnessSendMetadataSchema)(
      metadata === undefined ? {} : metadata,
    );
    return { ...args, ...runtime[HARNESS_SEND_META_KEY] };
  }).pipe(Effect.withSpan("decodeHarnessSendCall"));
}

/** Decoded empty adapter-operation result. */
export type HarnessEmptyResult = typeof harnessEmptyResultSchema.Type;

/** JSON Schema advertised for the delivery acknowledgment operation. */
export const harnessAcknowledgeDeliveryRequestJsonSchema = JSONSchema.make(
  harnessAcknowledgeDeliveryRequestSchema,
  { target: "jsonSchema2020-12" },
);

/** JSON Schema advertised for `send_message` arguments. */
export const harnessSendArgumentsJsonSchema = JSONSchema.make(
  harnessSendArgumentsSchema,
  { target: "jsonSchema2020-12" },
);

/** JSON Schema advertised for `send_message` results. */
export const harnessSendResultJsonSchema = JSONSchema.make(
  harnessSendResultSchema,
  { target: "jsonSchema2020-12" },
);

/** JSON Schema advertised for empty adapter-operation results. */
export const harnessEmptyResultJsonSchema = JSONSchema.make(
  harnessEmptyResultSchema,
  { target: "jsonSchema2020-12" },
);

/** Closed wire failure vocabularies prevent internal diagnostics from escaping. */
export const harnessFailureReasons = {
  RUNTIME_READ_REASONS: new Set([
    "not-registered",
    "invalid-continuation",
    "invalid-event",
    "unknown-event",
    "persistence-failed",
  ]),
  REGISTER_REASONS: new Set([
    "dependency-unavailable",
    "persistence-failed",
    "incompatible-daemon",
  ]),
  STATUS_REASONS: new Set(["persistence-failed", "incompatible-daemon"]),
  SEARCH_AGENTS_REASONS: new Set([
    "not-registered",
    "dependency-unavailable",
    "incompatible-daemon",
  ]),
  SEARCH_CONVERSATIONS_REASONS: new Set([
    "not-registered",
    "invalid-address",
    "persistence-failed",
  ]),
  READ_CONVERSATION_REASONS: new Set([
    "not-registered",
    "invalid-address",
    "unknown-agent",
    "invalid-continuation",
    "history-gap",
    "persistence-failed",
  ]),
  ACKNOWLEDGE_DELIVERY_REASONS: new Set([
    "unknown-delivery",
    "delivery-conflict",
    "persistence-failed",
    "transport-failed",
  ]),
};
