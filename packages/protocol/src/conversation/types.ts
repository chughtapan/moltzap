/**
 * @file Conversation identifiers, wire shapes, and domain errors.
 */

import { Schema } from "effect";
import {
  dateTimeStringSchema,
  brandedId,
  formatString,
} from "../transport/wire-string.js";
import { AgentId } from "../identity/agents.js";

const DateTimeString = dateTimeStringSchema();

/** Optional supplemental wire fields every domain tagged-error carries. */
const errorPayloadFields = {
  message: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
} as const;

/** Branded conversation identifier. */
export const ConversationId = brandedId("ConversationId");

/** Branded conversation identifier value. */
export type ConversationId = Schema.Schema.Type<typeof ConversationId>;

/**
 * Branded message identifier.
 *
 * This lives in the conversation module to keep the message module downstream:
 * conversation participant state references the last-read message, and message
 * rows reference their conversation.
 */
export const MessageId = brandedId("MessageId");

/** Branded message identifier value. */
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

/** The conversation is archived and cannot accept the requested mutation. */
export class ConversationArchivedError extends Schema.TaggedError<ConversationArchivedError>()(
  "ConversationArchived",
  errorPayloadFields,
) {
  static readonly message = "Conversation is archived";
}

/** The conversation has reached its participant capacity. */
export class ConversationFullError extends Schema.TaggedError<ConversationFullError>()(
  "ConversationFull",
  errorPayloadFields,
) {
  static readonly message = "Conversation is full";
}

/**
 * A requested conversation participant is not admitted to the task that owns
 * the conversation.
 */
export class ParticipantNotAdmittedError extends Schema.TaggedError<ParticipantNotAdmittedError>()(
  "ParticipantNotAdmitted",
  errorPayloadFields,
) {
  static readonly message = "Agent is not admitted to the task";
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

/** Conversation row visible on task conversation surfaces. */
export type Conversation = Schema.Schema.Type<typeof ConversationSchema>;

/** Participant row for a conversation. */
export type ConversationParticipant = Schema.Schema.Type<
  typeof ConversationParticipantSchema
>;

/** Conversation summary row used by list surfaces. */
export type ConversationSummary = Schema.Schema.Type<
  typeof ConversationSummarySchema
>;

/**
 * Return the canonical conversation schema.
 * @returns The canonical conversation schema.
 */
export function conversationSchema(): typeof ConversationSchema {
  return ConversationSchema;
}
