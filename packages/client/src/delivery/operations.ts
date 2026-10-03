/** @file The values harness operations take, return and persist: sends, inbox pages, events and acknowledgments. */

import { Effect, type ParseResult, Schema, type SchemaAST } from "effect";
import type { SendError } from "../transport/messaging/errors.js";
import {
  DeliveryToken,
  type EndpointStore,
  type InboxSummary,
} from "../store/types.js";
import {
  type CollectiveError,
  CollectiveId,
  decodeCollectiveFailure,
  SendInput,
} from "../transport/collectives/forms.js";
import { InboundItem } from "../transport/collectives/inbound.js";
import { exactStruct } from "../transport/wire/index.js";

const exact: SchemaAST.ParseOptions = {
  exact: true,
  onExcessProperty: "error",
};

/** Canonical event identities reuse the immutable inbox binding's random bytes. */
export const eventIdSchema = Schema.String.pipe(
  Schema.pattern(/^evt_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u),
);
/** Read-only content lookup never acknowledges or retries delivery. */
export const readEventRequestSchema = exactStruct({ eventId: eventIdSchema });
/** The original classified payload, including after its handoff. */
export const readEventResultSchema = exactStruct({ item: InboundItem });

/** A delivery acknowledgment names the delivery it retires. */
export const harnessAcknowledgeDeliveryRequestSchema = exactStruct({
  deliveryToken: DeliveryToken,
});

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
export const harnessSendOptionsSchema = exactStruct({
  idempotencyKey: Schema.optionalWith(invocationKey, { exact: true }),
  failureDelivery: Schema.optionalWith(Schema.Literal("result", "inbound"), {
    exact: true,
  }),
});
/** The model-visible arguments of one send. */
export const harnessSendArgumentsSchema = exactStruct({ input: SendInput });
const harnessSendRequestSchema = exactStruct({
  ...harnessSendArgumentsSchema.fields,
  ...harnessSendOptionsSchema.fields,
});
/**
 * A completed operation. A collecting operation names the id its answers and
 * result carry; a multicast has none, so its result is empty.
 */
export const harnessSendResultSchema = exactStruct({
  operationId: Schema.optionalWith(CollectiveId, { exact: true }),
});
const harnessMessageReadyEventSchema = exactStruct({
  deliveryToken: DeliveryToken,
  item: InboundItem,
});

/** One page request over the classified inbox. */
export const inboxRequestSchema = exactStruct({
  cursor: Schema.optionalWith(Schema.String, { exact: true }),
});
/** One page of classified deliveries and the cursor after it. */
export const inboxResultSchema = exactStruct({
  items: Schema.Array(harnessMessageReadyEventSchema),
  nextCursor: Schema.optionalWith(Schema.String, { exact: true }),
});
/** Caller-selected identity of one previously attempted send. */
export const readSendRequestSchema = exactStruct({
  idempotencyKey: invocationKey,
});

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

/** Observed invocation evidence without a collective completion claim. */
// eslint-disable-next-line agent-code-guard/no-exported-brand-constructor -- The MCP catalog projects the closed send-state union to JSON Schema.
export const readSendResultSchema = Schema.Union(
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

/** Decoded delivery acknowledgment arguments owned by the daemon. */
export type HarnessAcknowledgeDeliveryRequest =
  typeof harnessAcknowledgeDeliveryRequestSchema.Type;

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

type ClosedOperationError = Readonly<{ readonly reason: string }>;

/** The delivery operations a host calls: inbox and event reads, sends, and acknowledgments. */
export interface DeliveryOperations {
  readonly readEvent: (
    input: typeof readEventRequestSchema.Type,
  ) => Effect.Effect<typeof readEventResultSchema.Type, ClosedOperationError>;
  readonly readInboxSummary: () => Effect.Effect<
    InboxSummary,
    ClosedOperationError
  >;
  readonly readInbox: (
    input: HarnessReadInboxRequest,
  ) => Effect.Effect<HarnessReadInboxResult, ClosedOperationError>;
  readonly readSend: (
    input: HarnessReadSendRequest,
  ) => Effect.Effect<HarnessReadSendResult, ClosedOperationError>;
  readonly send: (
    request: HarnessSendRequest,
  ) => Effect.Effect<HarnessSendResult, SendError | CollectiveError>;
  readonly acknowledgeDelivery: (
    deliveryToken: DeliveryToken,
  ) => Effect.Effect<void, ClosedOperationError>;
}
