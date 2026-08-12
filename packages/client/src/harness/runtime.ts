/**
 * @file Defines package-private MCP schemas and metadata for daemon turns,
 * conversation-bound replies, and transitional daemon status.
 */
import {
  conversationId,
  type ConversationId,
} from "@moltzap/protocol/conversation";
import { agentId } from "@moltzap/protocol/identity";
import { messageReceivedNotificationDefinition } from "@moltzap/protocol/message";
import { JSONSchema, Schema } from "effect";

/** Harness MCP extension carrying the runtime event contract. */
export const HARNESS_EVENTS_EXTENSION = "xyz.moltzap/events-v1";

/** Subscription filter requesting reply-capable harness turns. */
export const HARNESS_TURN_READY_FILTER = "xyz.moltzap/turnReady";

/** Notification method carrying one coalesced inbound turn. */
export const HARNESS_TURN_READY_NOTIFICATION =
  "notifications/xyz.moltzap/turn_ready";

/** Tool used for model output in the current conversation. */
export const HARNESS_REPLY_TOOL = "reply";

const messageSchema =
  messageReceivedNotificationDefinition.paramsSchema.fields.message;

/** One nonempty batch of protocol messages delivered as a model turn. */
const harnessTurnEventSchema = Schema.Struct({
  messages: Schema.NonEmptyArray(messageSchema),
}).pipe(
  Schema.filter(
    (turn) =>
      turn.messages.every(
        (message) => message.conversationId === turn.messages[0].conversationId,
      ) || "every turn message must belong to the same conversation",
  ),
);

/** Advertised reply arguments. Routing authority remains outside tool input. */
const harnessReplyInputSchema = Schema.Struct({
  payload: Schema.String,
});

const emptyStatusInputJsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

/** The reply operation has no additional result data. */
const harnessReplyResultSchema = Schema.Struct({});

/** Private route nested under the harness extension key in MCP request metadata. */
const harnessReplyRouteSchema = Schema.Struct({
  conversationId,
});

/** Status takes no arguments because the daemon already owns its local slot. */
const harnessStatusInputSchema = Schema.Struct({}).annotations({
  jsonSchema: emptyStatusInputJsonSchema,
});

/** Transitional identity and connection state preserved during daemon cutover. */
const harnessStatusResultSchema = Schema.Struct({
  agentId: Schema.optional(agentId),
  connected: Schema.Boolean,
  conversations: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});

/** Decoded harness turn event. */
export type HarnessTurnEvent = Schema.Schema.Type<
  typeof harnessTurnEventSchema
>;

/** Decoded reply input. */
export type HarnessReplyInput = Schema.Schema.Type<
  typeof harnessReplyInputSchema
>;

/** Decoded reply result. */
export type HarnessReplyResult = Schema.Schema.Type<
  typeof harnessReplyResultSchema
>;

/** Decoded private reply route. */
export type HarnessReplyRoute = Schema.Schema.Type<
  typeof harnessReplyRouteSchema
>;

/** Decoded daemon status input. */
export type HarnessStatusInput = Schema.Schema.Type<
  typeof harnessStatusInputSchema
>;

/** Decoded transitional daemon status result. */
export type HarnessStatusResult = Schema.Schema.Type<
  typeof harnessStatusResultSchema
>;

const decodeTurnEvent = Schema.decodeUnknown(harnessTurnEventSchema);
const decodeReplyRoute = Schema.decodeUnknown(harnessReplyRouteSchema);
const strictDecodeOptions = { onExcessProperty: "error" } as const;

/** JSON Schema advertised for the payload-only reply tool arguments. */
export const harnessReplyInputJsonSchema = JSONSchema.make(
  harnessReplyInputSchema,
  { target: "jsonSchema2020-12" },
);

/** JSON Schema advertised for the empty reply result. */
export const harnessReplyResultJsonSchema = JSONSchema.make(
  harnessReplyResultSchema,
  { target: "jsonSchema2020-12" },
);

/** JSON Schema advertised for the empty status arguments. */
export const harnessStatusInputJsonSchema = JSONSchema.make(
  harnessStatusInputSchema,
  { target: "jsonSchema2020-12" },
);

/** JSON Schema advertised for the transitional daemon status result. */
export const harnessStatusResultJsonSchema = JSONSchema.make(
  harnessStatusResultSchema,
  { target: "jsonSchema2020-12" },
);

/**
 * Strictly decode a turn event received from the MCP boundary.
 * @param value Untrusted notification parameters.
 * @returns The decoded nonempty protocol-message batch.
 */
export const decodeHarnessTurnEvent = (value: unknown) =>
  decodeTurnEvent(value, strictDecodeOptions);

/**
 * Build the private request metadata consumed by the production harness client.
 * @param originatingConversationId Conversation associated with the live turn.
 * @returns Namespaced MCP request metadata containing the private route.
 */
export const harnessReplyRequestMeta = (
  originatingConversationId: ConversationId,
): Readonly<Record<string, unknown>> => ({
  [HARNESS_EVENTS_EXTENSION]: {
    conversationId: originatingConversationId,
  },
});

const isUnknownRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/**
 * Decode the private reply route while allowing unrelated MCP metadata keys.
 * @param requestMeta Untrusted MCP request metadata.
 * @returns The decoded conversation route.
 */
export const decodeHarnessReplyRoute = (requestMeta: unknown) => {
  const extensionValue: unknown = isUnknownRecord(requestMeta)
    ? requestMeta[HARNESS_EVENTS_EXTENSION]
    : undefined;
  return decodeReplyRoute(extensionValue, strictDecodeOptions);
};

/**
 * Return the conversation carried by the first message in a nonempty turn.
 * @param turn Decoded nonempty message batch.
 * @returns Conversation carried by the first protocol message.
 */
export const harnessTurnConversationId = (
  turn: HarnessTurnEvent,
): ConversationId => turn.messages[0].conversationId;
