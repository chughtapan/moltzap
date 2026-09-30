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
import { DeliveryToken } from "./endpoint/store/types.js";

/** A content-free wakeup to read the classified runtime inbox. */
export const INBOX_PENDING_EVENT = "moltzap.inbox.pending";

/** Adapter operation performing one collective operation. */
export const HARNESS_SEND_TOOL = "send_message";

/** Adapter operation acknowledging successful stock host callback completion. */
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
 * One `send_message` call: the send, and where a refused gather or response
 * reports its error. `inbound` is for a host whose tool returns before the
 * send: the call completes and the error arrives as an `operationFailed`
 * item. The default returns it as the tool error.
 */
const harnessSendRequestSchema = exactStruct({
  input: SendInput,
  idempotencyKey: Schema.optionalWith(invocationKey, { exact: true }),
  failureDelivery: Schema.optionalWith(Schema.Literal("result", "inbound"), {
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
/** Decode a retained validated send input before replaying its outcome. */
export const decodeHarnessSendRequest = Schema.decodeUnknown(
  harnessSendRequestSchema,
);

/** Decoded delivery acknowledgment arguments owned by the daemon. */
export type HarnessAcknowledgeDeliveryRequest =
  typeof harnessAcknowledgeDeliveryRequestSchema.Type;

/** Decoded empty adapter-operation result. */
export type HarnessEmptyResult = typeof harnessEmptyResultSchema.Type;

/** Decoded arguments of one `send_message` call. */
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
export const harnessSendRequestJsonSchema = JSONSchema.make(
  harnessSendRequestSchema,
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
