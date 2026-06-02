import { Schema } from "effect";
import {
  dateTimeStringSchema,
  brandedId,
  formatString,
} from "../schema-primitives.js";
import { AgentId } from "../identity/agents.js";

const DateTimeString = dateTimeStringSchema();

/** Optional supplemental wire fields every domain tagged-error carries. */
const errorPayloadFields = {
  message: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
} as const;

export const ConversationId = brandedId("ConversationId");
export type ConversationId = Schema.Schema.Type<typeof ConversationId>;
// MessageId brand lives here (rather than in messages.ts) to break the
// otherwise-circular `conversations <-> messages` import: the participant
// schema below references MessageId, and messages.ts already references
// ConversationId. Owning the brand at the upstream end keeps the dep
// graph one-way.
export const MessageId = brandedId("MessageId");
export type MessageId = Schema.Schema.Type<typeof MessageId>;

/** The referenced conversation does not exist under the task (or is not visible). */
export class ConversationNotFoundError extends Schema.TaggedError<ConversationNotFoundError>()(
  "ConversationNotFound",
  errorPayloadFields,
) {
  static readonly message = "Conversation not found";
}

/** The caller is not a participant in the conversation it is acting on. */
export class NotAParticipantError extends Schema.TaggedError<NotAParticipantError>()(
  "NotAParticipant",
  errorPayloadFields,
) {
  static readonly message = "Not a participant in the conversation";
}

export class ConversationArchivedError extends Schema.TaggedError<ConversationArchivedError>()(
  "ConversationArchived",
  errorPayloadFields,
) {
  static readonly message = "Conversation is archived";
}

export class ConversationFullError extends Schema.TaggedError<ConversationFullError>()(
  "ConversationFull",
  errorPayloadFields,
) {
  static readonly message = "Conversation is full";
}

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
  // Present iff the conversation is archived. Clients filter
  // `archivedAt !== undefined` to exclude archived rows from a
  // `TaskConversationList` response; the server returns archived rows
  // unfiltered, since the visibility contract for
  // `TaskConversationList` is "caller in `conversation_participants`",
  // not "archived excluded".
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
