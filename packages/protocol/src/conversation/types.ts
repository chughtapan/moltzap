/**
 * @file Conversation identifiers, wire shapes, and domain errors.
 */

import { Schema, type Brand } from "effect";
import {
  dateTimeStringSchema,
  formatString,
  errorPayloadFields,
} from "#transport";
import { agentId } from "#identity/agents";

const dateTimeString = dateTimeStringSchema();

/** Branded conversation identifier. */
export type ConversationId = string & Brand.Brand<"ConversationId">;
/** Validates and decodes conversation id values. */
export const conversationId: Schema.Schema<ConversationId, string> =
  formatString("uuid").pipe(
    Schema.brand("ConversationId"),
    Schema.annotations({ description: "Branded ConversationId" }),
  );

/**
 * Branded message identifier.
 *
 * This lives in the conversation module to keep the message module downstream:
 * conversation participant state references the last-read message, and message
 * rows reference their conversation.
 */
export type MessageId = string & Brand.Brand<"MessageId">;
/** Validates and decodes message id values. */
export const messageId: Schema.Schema<MessageId, string> = formatString(
  "uuid",
).pipe(
  Schema.brand("MessageId"),
  Schema.annotations({ description: "Branded MessageId" }),
);

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

const agentParticipantRefSchema = Schema.Struct({
  type: Schema.Literal("agent"),
  id: formatString("uuid"),
});

const conversationMetadataSchema = Schema.Struct({
  tags: Schema.optional(
    Schema.Array(Schema.Record({ key: Schema.String, value: Schema.String })),
  ),
});

const conversationSchemaValue = Schema.Struct({
  id: conversationId,
  name: Schema.optional(Schema.String),
  createdBy: agentId,
  metadata: Schema.optional(conversationMetadataSchema),
  lastMessageTimestamp: Schema.optional(dateTimeString),
  createdAt: dateTimeString,
  updatedAt: dateTimeString,
  // Present iff the conversation is archived. Clients filter
  // `archivedAt !== undefined` to exclude archived rows from a
  // `ConversationList` response; the server returns archived rows
  // unfiltered, since the visibility contract for
  // `ConversationList` is "caller in `conversation_participants`",
  // not "archived excluded".
  archivedAt: Schema.optional(dateTimeString),
});

/** Schema for a participant row attached to a conversation. */
export const conversationParticipantSchema = Schema.Struct({
  conversationId: conversationId,
  participant: agentParticipantRefSchema,
  joinedAt: dateTimeString,
  lastReadMessageId: Schema.optional(messageId),
  agentName: Schema.optional(Schema.String),
  agentDisplayName: Schema.optional(Schema.String),
});

/** Schema for the compact conversation summary returned by list surfaces. */
export const conversationSummarySchema = Schema.Struct({
  id: conversationId,
  name: Schema.optional(Schema.String),
  lastMessagePreview: Schema.optional(Schema.String),
  lastMessageTimestamp: Schema.optional(dateTimeString),
  unreadCount: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(0)),
  metadata: Schema.optional(conversationMetadataSchema),
  participants: Schema.optional(Schema.Array(agentParticipantRefSchema)),
});

/** Conversation row visible on task conversation surfaces. */
export type Conversation = Schema.Schema.Type<typeof conversationSchemaValue>;

/** Participant row for a conversation. */
export type ConversationParticipant = Schema.Schema.Type<
  typeof conversationParticipantSchema
>;

/** Conversation summary row used by list surfaces. */
export type ConversationSummary = Schema.Schema.Type<
  typeof conversationSummarySchema
>;

/**
 * Return the canonical conversation schema.
 * @returns The canonical conversation schema.
 */
export function conversationSchema(): typeof conversationSchemaValue {
  return conversationSchemaValue;
}
