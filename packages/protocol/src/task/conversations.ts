import { Data, Schema } from "effect";
import {
  dateTimeStringSchema,
  brandedId,
  formatString,
} from "../schema-primitives.js";
import { AgentId } from "../identity/agents.js";
import {
  registerErrorClass,
  type RpcErrorPayload,
} from "../transport/wire-errors.js";

const DateTimeString = dateTimeStringSchema();

export const ConversationId = brandedId("ConversationId");
export type ConversationId = Schema.Schema.Type<typeof ConversationId>;
// MessageId brand lives here (rather than in messages.ts) to break the
// otherwise-circular `conversations <-> messages` import: the participant
// schema below references MessageId, and messages.ts already references
// ConversationId. Owning the brand at the upstream end keeps the dep
// graph one-way.
export const MessageId = brandedId("MessageId");
export type MessageId = Schema.Schema.Type<typeof MessageId>;

export class ConversationArchivedError extends Data.TaggedError(
  "ConversationArchived",
)<RpcErrorPayload> {
  static readonly code = -32022;
  static readonly message = "Conversation is archived";
}
registerErrorClass(ConversationArchivedError);

export class ConversationFullError extends Data.TaggedError(
  "ConversationFull",
)<RpcErrorPayload> {
  static readonly code = -32007;
  static readonly message = "Conversation is full";
}
registerErrorClass(ConversationFullError);

const AgentParticipantRefSchema = Schema.Struct({
  type: Schema.Literal("agent"),
  id: formatString("uuid"),
});

const ConversationMetadataSchema = Schema.Struct({
  tags: Schema.optional(
    Schema.Array(Schema.Record({ key: Schema.String, value: Schema.String })),
  ),
});

const ConversationSchema = Schema.Struct({
  id: ConversationId,
  name: Schema.optional(Schema.String),
  createdBy: AgentId,
  metadata: Schema.optional(ConversationMetadataSchema),
  lastMessageTimestamp: Schema.optional(DateTimeString),
  createdAt: DateTimeString,
  updatedAt: DateTimeString,
  // Spec D1 (#598) — additive field. Present iff the conversation
  // is archived. Clients filter `archivedAt !== undefined` to
  // exclude archived rows from a `TaskConversationList` response
  // (the server returns archived rows unfiltered; the visibility
  // contract for `TaskConversationList` is "caller in
  // `conversation_participants`", not "archived excluded").
  archivedAt: Schema.optional(DateTimeString),
});

const ConversationParticipantSchema = Schema.Struct({
  conversationId: ConversationId,
  participant: AgentParticipantRefSchema,
  joinedAt: DateTimeString,
  lastReadMessageId: Schema.optional(MessageId),
  agentName: Schema.optional(Schema.String),
  agentDisplayName: Schema.optional(Schema.String),
});

const ConversationSummarySchema = Schema.Struct({
  id: ConversationId,
  name: Schema.optional(Schema.String),
  lastMessagePreview: Schema.optional(Schema.String),
  lastMessageTimestamp: Schema.optional(DateTimeString),
  unreadCount: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  metadata: Schema.optional(ConversationMetadataSchema),
  participants: Schema.optional(Schema.Array(AgentParticipantRefSchema)),
});

export type Conversation = Schema.Schema.Type<typeof ConversationSchema>;
export type ConversationParticipant = Schema.Schema.Type<
  typeof ConversationParticipantSchema
>;
export type ConversationSummary = Schema.Schema.Type<
  typeof ConversationSummarySchema
>;

export function conversationSchema(): typeof ConversationSchema {
  return ConversationSchema;
}
