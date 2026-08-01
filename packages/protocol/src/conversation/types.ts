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
 * message rows reference their conversation, so the identifier both domains
 * share belongs to the one they both sit above.
 */
export type MessageId = string & Brand.Brand<"MessageId">;
/** Validates and decodes message id values. */
export const messageId: Schema.Schema<MessageId, string> = formatString(
  "uuid",
).pipe(
  Schema.brand("MessageId"),
  Schema.annotations({ description: "Branded MessageId" }),
);

/** The referenced conversation does not exist (or is not visible to the caller). */
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

/** The conversation has reached its participant capacity. */
export class ConversationFullError extends Schema.TaggedError<ConversationFullError>()(
  "ConversationFull",
  errorPayloadFields,
) {
  static readonly message = "Conversation is full";
}

const conversationSchemaValue = Schema.Struct({
  id: conversationId,
  name: Schema.optional(Schema.String),
  createdBy: agentId,
  createdAt: dateTimeString,
  updatedAt: dateTimeString,
});

/** Conversation row visible on conversation surfaces. */
export type Conversation = Schema.Schema.Type<typeof conversationSchemaValue>;

/**
 * Return the canonical conversation schema.
 * @returns The canonical conversation schema.
 */
export function conversationSchema(): typeof conversationSchemaValue {
  return conversationSchemaValue;
}
