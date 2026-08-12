import { JSONSchema, Schema } from "effect";
import {
  conversationId,
  conversationSchema,
  conversationSearch,
  type ConversationId,
} from "@moltzap/protocol/conversation";
import { agentId, agentName } from "@moltzap/protocol/identity";
import { messageReceivedNotificationDefinition } from "@moltzap/protocol/message";

/** Harness MCP extension carrying the runtime event contract. */
export const HARNESS_EVENTS_EXTENSION = "xyz.moltzap/events-v1";

/** Subscription filter requesting reply-capable harness turns. */
export const HARNESS_TURN_READY_FILTER = "xyz.moltzap/turnReady";

/** Notification method carrying one coalesced inbound turn. */
export const HARNESS_TURN_READY_NOTIFICATION =
  "notifications/xyz.moltzap/turn_ready";

/**
 * Tool committing a Registry identity to the slot this daemon owns. Present
 * only while the slot has none; the six active tools replace it afterward.
 */
export const HARNESS_REGISTER_TOOL = "register";

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

/** Tool creating a conversation and sending its initial content. */
export const HARNESS_START_CONVERSATION_TOOL = "start_conversation";

const messageSchema =
  messageReceivedNotificationDefinition.paramsSchema.fields.message;

const conversationWithParticipantsSchema = Schema.Struct({
  ...conversationSchema().fields,
  participants: Schema.Array(agentId),
});

/** Arguments for creating a conversation through the harness. */
const harnessStartConversationInputSchema = Schema.Struct({
  otherAgentNames: Schema.NonEmptyArray(agentName),
  initialContent: Schema.String.pipe(Schema.minLength(1)),
});

/** Conversation returned after its initial content has been sent. */
const harnessStartConversationResultSchema = Schema.Struct({
  conversation: conversationWithParticipantsSchema,
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

/**
 * The daemon supplies the agent name and listener port from its own slot, so
 * registration arguments carry only what the Registry cannot derive locally.
 */
const harnessRegisterInputSchema = Schema.Struct({
  inviteCode: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  description: Schema.optional(Schema.String.pipe(Schema.maxLength(500))),
});

/**
 * Registration reports the committed identity and where it is reachable. Key
 * material is written to the slot and never returned over MCP.
 */
const harnessRegisterResultSchema = Schema.Struct({
  agentId,
  // The slot stores its agent name unbranded and the Registry has already
  // validated it by the time this result exists, so a second brand round-trip
  // inside the daemon would assert nothing new.
  agentName: Schema.String,
  serverUrl: Schema.String,
});

/** Status takes no arguments; the daemon reports on the slot it already owns. */
const harnessStatusInputSchema = Schema.Struct({});

/** Active daemon identity and connection state. */
const harnessStatusResultSchema = Schema.Struct({
  agentId: Schema.optional(agentId),
  connected: Schema.Boolean,
  conversations: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});

/** Decoded harness turn event. */
export type HarnessTurnEvent = Schema.Schema.Type<
  typeof harnessTurnEventSchema
>;

/**
 * Conversation plus its membership, assembled by the daemon because the
 * canonical Conversation sent over the network carries no participants. It
 * crosses only the loopback MCP boundary, and it is public because it names
 * what `HarnessClientService.startConversation` hands back to an adapter.
 */
export type ConversationWithParticipants = Schema.Schema.Type<
  typeof conversationWithParticipantsSchema
>;

/** Decoded start-conversation input. */
export type HarnessStartConversationInput = Schema.Schema.Type<
  typeof harnessStartConversationInputSchema
>;

/** Decoded start-conversation result. */
export type HarnessStartConversationResult = Schema.Schema.Type<
  typeof harnessStartConversationResultSchema
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

/** Decoded registration input. */
export type HarnessRegisterInput = Schema.Schema.Type<
  typeof harnessRegisterInputSchema
>;

/** Decoded registration result. */
export type HarnessRegisterResult = Schema.Schema.Type<
  typeof harnessRegisterResultSchema
>;

/** Decoded status input. */
export type HarnessStatusInput = Schema.Schema.Type<
  typeof harnessStatusInputSchema
>;

/** Decoded status result. */
export type HarnessStatusResult = Schema.Schema.Type<
  typeof harnessStatusResultSchema
>;

const strictDecodeOptions = { onExcessProperty: "error" } as const;
const decodeTurnEvent = Schema.decodeUnknown(harnessTurnEventSchema);
const decodeSearchConversationsResult = Schema.decodeUnknown(
  harnessSearchConversationsResultSchema,
);
const decodeStartConversationResult = Schema.decodeUnknown(
  harnessStartConversationResultSchema,
);
const decodeReplyRoute = Schema.decodeUnknown(harnessReplyRouteSchema);
const decodeStatusResult = Schema.decodeUnknown(harnessStatusResultSchema);

/** JSON Schema advertised for start-conversation arguments. */
export const harnessStartConversationInputJsonSchema = JSONSchema.make(
  harnessStartConversationInputSchema,
  { target: "jsonSchema2020-12" },
);

/** JSON Schema advertised for the start-conversation result. */
export const harnessStartConversationResultJsonSchema = JSONSchema.make(
  harnessStartConversationResultSchema,
  { target: "jsonSchema2020-12" },
);

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

/** JSON Schema advertised for registration arguments. */
export const harnessRegisterInputJsonSchema = JSONSchema.make(
  harnessRegisterInputSchema,
  { target: "jsonSchema2020-12" },
);

/** JSON Schema advertised for the registration result. */
export const harnessRegisterResultJsonSchema = JSONSchema.make(
  harnessRegisterResultSchema,
  { target: "jsonSchema2020-12" },
);

/** JSON Schema advertised for the empty status arguments. */
export const harnessStatusInputJsonSchema = JSONSchema.make(
  harnessStatusInputSchema,
  { target: "jsonSchema2020-12" },
);

/** JSON Schema advertised for the status result. */
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
 * Strictly decode the membership-bearing conversation page received over MCP.
 * @param value Untrusted structured tool content.
 * @returns The decoded MCP-local conversation page.
 */
export const decodeHarnessSearchConversationsResult = (value: unknown) =>
  decodeSearchConversationsResult(value, strictDecodeOptions);

/**
 * Strictly decode a conversation created through the harness MCP boundary.
 * @param value Untrusted structured tool content.
 * @returns The created conversation with MCP-local membership.
 */
export const decodeHarnessStartConversationResult = (value: unknown) =>
  decodeStartConversationResult(value, strictDecodeOptions);

/**
 * Strictly decode the daemon status reported over the MCP boundary.
 * @param value Untrusted structured tool content.
 * @returns The decoded identity and connection state.
 */
export const decodeHarnessStatusResult = (value: unknown) =>
  decodeStatusResult(value, strictDecodeOptions);

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
