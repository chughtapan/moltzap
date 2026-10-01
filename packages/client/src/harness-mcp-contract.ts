/** @file Closed private representation of the loopback HarnessEndpoint MCP wire. */

import {
  Effect,
  JSONSchema,
  type ParseResult,
  Schema,
  type SchemaAST,
} from "effect";
import {
  CollectiveId,
  decodeCollectiveFailure,
  InboundItem,
  SendInput,
} from "./contract.js";
import { DeliveryToken, type EndpointStore } from "./endpoint/store/types.js";

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

const exactStruct = <Fields extends Schema.Struct.Fields>(fields: Fields) =>
  Schema.Struct(fields).annotations({ parseOptions: exact });

const exactEmptyObject = Schema.Record({
  key: Schema.String,
  value: Schema.Never,
}).annotations({ parseOptions: exact });

/** Canonical event identities reuse the immutable inbox binding's random bytes. */
export const eventIdSchema = Schema.String.pipe(
  Schema.pattern(/^evt_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u),
);
/** Read-only content lookup never acknowledges or retries delivery. */
export const readEventRequestSchema = exactStruct({ eventId: eventIdSchema });
/** The original classified payload, including after its handoff. */
export const readEventResultSchema = exactStruct({ item: InboundItem });
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

const harnessAcknowledgeDeliveryRequestSchema = exactStruct({
  deliveryToken: DeliveryToken,
});
const harnessEmptyResultSchema = exactEmptyObject;

const utf8 = new TextEncoder();
const invocationKey = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(128),
  Schema.filter(
    (value) =>
      !value.includes("\u0000") && utf8.encode(value).byteLength <= 128,
  ),
);
/**
 * Runtime identity and routing of a refused gather or response.
 * `inbound` is for a host whose tool returns before the
 * send: the call completes and the error arrives as an `operationFailed`
 * item. The default returns it as the tool error.
 */
const harnessSendOptionsSchema = exactStruct({
  idempotencyKey: Schema.optionalWith(invocationKey, { exact: true }),
  failureDelivery: Schema.optionalWith(Schema.Literal("result", "inbound"), {
    exact: true,
  }),
});
const harnessSendArgumentsSchema = exactStruct({ input: SendInput });
const harnessSendRequestSchema = exactStruct({
  ...harnessSendArgumentsSchema.fields,
  ...harnessSendOptionsSchema.fields,
});
const harnessSendMetadataSchema = Schema.Struct({
  [HARNESS_SEND_META_KEY]: Schema.optionalWith(harnessSendOptionsSchema, {
    exact: true,
  }),
});
/**
 * A completed operation. A collecting operation names the id its answers and
 * result carry; a multicast has none, so its result is empty.
 */
const harnessSendResultSchema = exactStruct({
  operationId: Schema.optionalWith(CollectiveId, { exact: true }),
});
const harnessMessageReadyEventSchema = exactStruct({
  deliveryToken: DeliveryToken,
  item: InboundItem,
});

const inboxRequestSchema = exactStruct({
  cursor: Schema.optionalWith(Schema.String, { exact: true }),
});
const inboxResultSchema = exactStruct({
  items: Schema.Array(harnessMessageReadyEventSchema),
  nextCursor: Schema.optionalWith(Schema.String, { exact: true }),
});
const readSendRequestSchema = exactStruct({ idempotencyKey: invocationKey });

/**
 * The JSON-RPC error data of a refused `send_message`: a `SendError` reason,
 * or a refused collective send with its id and the failure naming each
 * unreachable member or failing field, which `decodeCollectiveFailure`
 * validates.
 */
const harnessSendErrorDataSchema = Schema.Union(
  exactStruct({
    reason: Schema.Literal("collective-failed"),
    id: CollectiveId,
    failure: Schema.Unknown,
  }),
  exactStruct({ reason: Schema.String }),
);

/** Exact retained result of one invocation; failure is not proof of no post. */
const harnessSendOutcomeSchema = Schema.Union(
  exactStruct({
    kind: Schema.Literal("success"),
    result: harnessSendResultSchema,
  }),
  exactStruct({
    kind: Schema.Literal("failure"),
    error: harnessSendErrorDataSchema,
  }),
);

const readSendResultSchema = Schema.Union(
  exactStruct({ state: Schema.Literal("absent") }),
  exactStruct({
    state: Schema.Literal("pending", "indeterminate"),
    input: SendInput,
  }),
  exactStruct({
    state: Schema.Literal("returned"),
    input: SendInput,
    outcome: harnessSendOutcomeSchema,
  }),
);

/** Validate the persisted wire outcome before reconstructing a typed send result. */
export const decodeHarnessSendOutcome = Schema.decodeUnknown(
  harnessSendOutcomeSchema,
);

/** Decoded pagination request for the current classified inbox. */
export type HarnessReadInboxRequest = typeof inboxRequestSchema.Type;
/** Classified deliveries, bounded by the daemon's snapshot pagination. */
export type HarnessReadInboxResult = typeof inboxResultSchema.Type;
/** Caller-selected identity of one previously attempted send. */
export type HarnessReadSendRequest = typeof readSendRequestSchema.Type;
/** Observed invocation evidence without a collective completion claim. */
export type HarnessReadSendResult = typeof readSendResultSchema.Type;
/** Retained tool outcome for a keyed invocation. */
export type HarnessSendOutcome = typeof harnessSendOutcomeSchema.Type;

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

/** Decode a bounded inbox page received through the MCP transport. */
export const decodeHarnessReadInboxResult =
  Schema.decodeUnknown(inboxResultSchema);
/** Validate the keyed lookup at the tool boundary, including its UTF-8 bound. */
export const decodeHarnessReadSendRequest = Schema.decodeUnknown(
  readSendRequestSchema,
);
/** Validate a daemon invocation before binding its input in the durable store. */
export const decodeHarnessSendRequest = Schema.decodeUnknown(
  harnessSendRequestSchema,
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

/** Decoded delivery acknowledgment arguments owned by the daemon. */
export type HarnessAcknowledgeDeliveryRequest =
  typeof harnessAcknowledgeDeliveryRequestSchema.Type;

/** Decoded empty adapter-operation result. */
export type HarnessEmptyResult = typeof harnessEmptyResultSchema.Type;

/** Semantic arguments advertised to the host's model tool projection. */
export type HarnessSendArguments = typeof harnessSendArgumentsSchema.Type;

/** Validated semantic input and runtime options of one daemon invocation. */
export type HarnessSendRequest = typeof harnessSendRequestSchema.Type;

/** Decoded error data of one refused `send_message` call. */
export type HarnessSendErrorData =
  | Readonly<{ reason: string }>
  | Readonly<{
      reason: "collective-failed";
      id: CollectiveId;
      failure: Effect.Effect.Success<
        ReturnType<typeof decodeCollectiveFailure>
      >;
    }>;

/** Decoded result of one `send_message` operation. */
export type HarnessSendResult = typeof harnessSendResultSchema.Type;

/** One stable pending inbound item emitted by the daemon. */
export type HarnessMessageReadyEvent =
  typeof harnessMessageReadyEventSchema.Type;

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

/**
 * Decode one exact delivery acknowledgment request.
 * @param value Untrusted tool arguments.
 * @returns The validated request.
 */
export function decodeHarnessAcknowledgeDeliveryRequest(
  value: unknown,
): Effect.Effect<HarnessAcknowledgeDeliveryRequest, ParseResult.ParseError> {
  return Schema.decodeUnknown(harnessAcknowledgeDeliveryRequestSchema)(
    value,
    exact,
  );
}

/**
 * Decode one exact pending-delivery notification payload.
 * @param value Untrusted notification parameters.
 * @returns The validated pending delivery.
 */
export function decodeHarnessMessageReadyEvent(
  value: unknown,
): Effect.Effect<HarnessMessageReadyEvent, ParseResult.ParseError> {
  return Schema.decodeUnknown(harnessMessageReadyEventSchema)(value, exact);
}

/**
 * Decode the error data of one refused `send_message` call.
 * @param value Untrusted JSON-RPC error data.
 * @returns The collective failure or send reason it carries.
 */
export function decodeHarnessSendErrorData(
  value: unknown,
): Effect.Effect<HarnessSendErrorData, ParseResult.ParseError> {
  return Schema.decodeUnknown(harnessSendErrorDataSchema)(value, exact).pipe(
    Effect.flatMap(
      (data): Effect.Effect<HarnessSendErrorData, ParseResult.ParseError> =>
        "failure" in data
          ? decodeCollectiveFailure(data.failure).pipe(
              Effect.map((failure) => ({ ...data, failure })),
            )
          : Effect.succeed(data),
    ),
  );
}

/**
 * Decode one `send_message` result.
 * @param value Untrusted structured tool content.
 * @returns The operation id a gather names, if any.
 */
export function decodeHarnessSendResult(
  value: unknown,
): Effect.Effect<HarnessSendResult, ParseResult.ParseError> {
  return Schema.decodeUnknown(harnessSendResultSchema)(value, exact);
}

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

/** The existing endpoint store owns both callback progress and immutable inbox items. */
export type EventStore = Pick<
  EndpointStore,
  | "readEventState"
  | "writeEventState"
  | "readInbox"
  | "readInboxItem"
  | "readInboxSummary"
  | "completeWebhookDelivery"
>;

/** Reversible naming keeps lookup independent of subscription and retry state. */
export const eventIdOf = (token: DeliveryToken): string =>
  `evt_${token.slice(4)}`;
