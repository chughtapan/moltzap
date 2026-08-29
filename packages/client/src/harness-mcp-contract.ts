/** @file Closed private representation of the loopback HarnessEndpoint MCP wire. */

import {
  type Effect,
  JSONSchema,
  type ParseResult,
  Schema,
  type SchemaAST,
} from "effect";
import { InboundMessage } from "./contract.js";
import { DeliveryToken } from "./endpoint/store.js";

/** MCP capability carrying addressed message delivery. */
export const HARNESS_EVENTS_EXTENSION = "xyz.moltzap/events-v2";

/** Subscription filter requesting durable addressed messages. */
export const HARNESS_MESSAGE_READY_FILTER = "xyz.moltzap/messageReady";

/** Notification method carrying one pending addressed message. */
export const HARNESS_MESSAGE_READY_NOTIFICATION =
  "notifications/xyz.moltzap/message_ready";

/** Adapter operation for an explicit addressed send. */
export const HARNESS_SEND_TOOL = "send_message";

/** Adapter operation acknowledging native host persistence. */
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
const harnessMessageReadyEventSchema = exactStruct({
  deliveryToken: DeliveryToken,
  message: InboundMessage,
});

type HarnessEventsExtensionDeclaration =
  typeof harnessEventsExtensionDeclarationSchema.Type;

/** Decoded delivery acknowledgment arguments owned by the daemon. */
export type HarnessAcknowledgeDeliveryRequest =
  typeof harnessAcknowledgeDeliveryRequestSchema.Type;

/** Decoded empty adapter-operation result. */
export type HarnessEmptyResult = typeof harnessEmptyResultSchema.Type;

/** One stable pending delivery emitted by the daemon. */
export type HarnessMessageReadyEvent =
  typeof harnessMessageReadyEventSchema.Type;

/** JSON Schema advertised for the delivery acknowledgment operation. */
export const harnessAcknowledgeDeliveryRequestJsonSchema = JSONSchema.make(
  harnessAcknowledgeDeliveryRequestSchema,
  { target: "jsonSchema2020-12" },
);

/** JSON Schema advertised for empty adapter-operation results. */
export const harnessEmptyResultJsonSchema = JSONSchema.make(
  harnessEmptyResultSchema,
  { target: "jsonSchema2020-12" },
);

/**
 * Decode the exact events-v2 capability declaration.
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
