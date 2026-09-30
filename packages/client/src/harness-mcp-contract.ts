/** @file Closed private representation of the loopback HarnessEndpoint MCP wire. */

import {
  type Effect,
  JSONSchema,
  type ParseResult,
  Schema,
  type SchemaAST,
} from "effect";
import { InboundItem } from "./contract.js";
import { CollectiveId } from "./endpoint/collective/operation.js";
import { DeliveryToken } from "./endpoint/store/types.js";

/** MCP capability carrying tagged inbound item delivery. */
export const HARNESS_EVENTS_EXTENSION = "xyz.moltzap/events-v3";

/** Subscription filter requesting durable inbound items. */
export const HARNESS_MESSAGE_READY_FILTER = "xyz.moltzap/messageReady";

/** Notification method carrying one pending inbound item. */
export const HARNESS_MESSAGE_READY_NOTIFICATION =
  "notifications/xyz.moltzap/message_ready";

/** Adapter operation performing one collective operation. */
export const HARNESS_SEND_TOOL = "send_message";

/** Adapter operation acknowledging successful stock host callback completion. */
export const HARNESS_ACKNOWLEDGE_DELIVERY_TOOL = "acknowledge_delivery";

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

const harnessEventsExtensionDeclarationSchema = exactEmptyObject;
const harnessAcknowledgeDeliveryRequestSchema = exactStruct({
  deliveryToken: DeliveryToken,
});
const harnessEmptyResultSchema = exactEmptyObject;
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

type HarnessEventsExtensionDeclaration =
  typeof harnessEventsExtensionDeclarationSchema.Type;

/** Decoded delivery acknowledgment arguments owned by the daemon. */
export type HarnessAcknowledgeDeliveryRequest =
  typeof harnessAcknowledgeDeliveryRequestSchema.Type;

/** Decoded empty adapter-operation result. */
export type HarnessEmptyResult = typeof harnessEmptyResultSchema.Type;

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
 * Decode the exact events-v3 capability declaration.
 * @param value Untrusted capability payload.
 * @returns The validated empty declaration.
 */
export function decodeHarnessEventsExtensionDeclaration(
  value: unknown,
): Effect.Effect<HarnessEventsExtensionDeclaration, ParseResult.ParseError> {
  return Schema.decodeUnknown(harnessEventsExtensionDeclarationSchema)(
    value,
    exact,
  );
}

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
