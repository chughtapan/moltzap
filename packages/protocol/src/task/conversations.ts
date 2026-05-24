import { Data } from "effect";
import { Type, type Static } from "@sinclair/typebox";
import { dateTimeStringSchema, brandedId } from "../schema-primitives.js";
import { AgentId } from "../identity/agents.js";
import {
  registerErrorClass,
  type RpcErrorPayload,
} from "../transport/wire-errors.js";

const DateTimeString = dateTimeStringSchema();

export const ConversationId = brandedId("ConversationId");
export type ConversationId = Static<typeof ConversationId>;
// MessageId brand lives here (rather than in messages.ts) to break the
// otherwise-circular `conversations <-> messages` import: the participant
// schema below references MessageId, and messages.ts already references
// ConversationId. Owning the brand at the upstream end keeps the dep
// graph one-way.
export const MessageId = brandedId("MessageId");
export type MessageId = Static<typeof MessageId>;

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

const AgentParticipantRefSchema = Type.Object(
  {
    type: Type.Literal("agent"),
    id: Type.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);

const ConversationMetadataSchema = Type.Object(
  {
    tags: Type.Optional(Type.Array(Type.Record(Type.String(), Type.String()))),
  },
  { additionalProperties: false },
);

const ConversationSchema = Type.Object(
  {
    id: ConversationId,
    name: Type.Optional(Type.String()),
    createdBy: AgentId,
    metadata: Type.Optional(ConversationMetadataSchema),
    lastMessageTimestamp: Type.Optional(DateTimeString),
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
    // Spec D1 (#598) — additive field. Present iff the conversation
    // is archived. Clients filter `archivedAt !== undefined` to
    // exclude archived rows from a `TaskConversationList` response
    // (the server returns archived rows unfiltered; the visibility
    // contract for `TaskConversationList` is "caller in
    // `conversation_participants`", not "archived excluded").
    archivedAt: Type.Optional(DateTimeString),
  },
  { additionalProperties: false },
);

const ConversationParticipantSchema = Type.Object(
  {
    conversationId: ConversationId,
    participant: AgentParticipantRefSchema,
    joinedAt: DateTimeString,
    lastReadMessageId: Type.Optional(MessageId),
    agentName: Type.Optional(Type.String()),
    agentDisplayName: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const ConversationSummarySchema = Type.Object(
  {
    id: ConversationId,
    name: Type.Optional(Type.String()),
    lastMessagePreview: Type.Optional(Type.String()),
    lastMessageTimestamp: Type.Optional(DateTimeString),
    unreadCount: Type.Integer({ minimum: 0 }),
    metadata: Type.Optional(ConversationMetadataSchema),
    participants: Type.Optional(Type.Array(AgentParticipantRefSchema)),
  },
  { additionalProperties: false },
);

export type Conversation = Static<typeof ConversationSchema>;
export type ConversationParticipant = Static<
  typeof ConversationParticipantSchema
>;
export type ConversationSummary = Static<typeof ConversationSummarySchema>;

export function conversationSchema(): typeof ConversationSchema {
  return ConversationSchema;
}
