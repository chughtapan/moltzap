import { JSONSchema, Schema } from "effect";
import {
  conversationId,
  conversationSchema,
  conversationSearch,
  type ConversationId,
} from "@moltzap/protocol/conversation";
import { agentId } from "@moltzap/protocol/identity";
import { messageReceivedNotificationDefinition } from "@moltzap/protocol/message";

/** Harness MCP extension carrying the runtime event contract. */
export const HARNESS_EVENTS_EXTENSION = "xyz.moltzap/events-v1";

/** Subscription filter requesting reply-capable harness turns. */
export const HARNESS_TURN_READY_FILTER = "xyz.moltzap/turnReady";

/** Notification method carrying one coalesced inbound turn. */
export const HARNESS_TURN_READY_NOTIFICATION =
  "notifications/xyz.moltzap/turn_ready";

/** Tool used for model output in the current conversation. */
export const HARNESS_REPLY_TOOL = "reply";

/** Tool returning the active daemon identity and connection state. */
export const HARNESS_STATUS_TOOL = "status";

/** Tool browsing or matching visible agent cards. */
export const HARNESS_SEARCH_AGENTS_TOOL = "search_agents";

/** Tool browsing or matching visible conversations. */
export const HARNESS_SEARCH_CONVERSATIONS_TOOL = "search_conversations";

/** Tool reading one checkpointed conversation history. */
export const HARNESS_READ_CONVERSATION_TOOL = "read_conversation";

const messageSchema =
  messageReceivedNotificationDefinition.paramsSchema.fields.message;

const conversationWithParticipantsSchema = Schema.Struct({
  ...conversationSchema().fields,
  participants: Schema.Array(agentId),
});

/** MCP-local search result used to reconstruct endpoint presentation. */
const harnessSearchConversationsResultSchema = Schema.Struct({
  ...conversationSearch.resultSchema.fields,
  conversations: Schema.Array(conversationWithParticipantsSchema),
});

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

/** The reply operation has no additional result data. */
const harnessReplyResultSchema = Schema.Struct({});

/** Private route nested under the harness extension key in MCP request metadata. */
const harnessReplyRouteSchema = Schema.Struct({
  conversationId,
});

/** Decoded harness turn event. */
export type HarnessTurnEvent = Schema.Schema.Type<
  typeof harnessTurnEventSchema
>;

/** Conversation projection carried only between the daemon and HarnessClient. */
export type ConversationWithParticipants = Schema.Schema.Type<
  typeof conversationWithParticipantsSchema
>;

/** Decoded MCP-local conversation search page. */
export type HarnessSearchConversationsResult = Schema.Schema.Type<
  typeof harnessSearchConversationsResultSchema
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

const strictDecodeOptions = { onExcessProperty: "error" } as const;
const decodeTurnEvent = Schema.decodeUnknown(harnessTurnEventSchema);
const decodeSearchConversationsResult = Schema.decodeUnknown(
  harnessSearchConversationsResultSchema,
);
const decodeReplyRoute = Schema.decodeUnknown(harnessReplyRouteSchema);

/** JSON Schema advertised for the MCP-local conversation search result. */
export const harnessSearchConversationsResultJsonSchema = JSONSchema.make(
  harnessSearchConversationsResultSchema,
  { target: "jsonSchema2020-12" },
);

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

/**
 * Strictly decode a turn event received from the MCP boundary.
 * @param value Untrusted notification parameters.
 * @returns The decoded nonempty protocol-message batch.
 */
export const decodeHarnessTurnEvent = (value: unknown) =>
  decodeTurnEvent(value, strictDecodeOptions);

/**
 * Strictly decode the membership-bearing conversation page received over MCP.
 * @param value Untrusted structured tool content.
 * @returns The decoded MCP-local conversation page.
 */
export const decodeHarnessSearchConversationsResult = (value: unknown) =>
  decodeSearchConversationsResult(value, strictDecodeOptions);

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
