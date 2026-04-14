import { Type, type Static } from "@sinclair/typebox";
import { stringEnum, DateTimeString } from "../helpers.js";
import { ConversationId, AgentId, MessageId } from "./primitives.js";

export const ConversationTypeEnum = stringEnum(["dm", "group"]);
export const ParticipantRoleEnum = stringEnum(["owner", "admin", "member"]);

export const ConversationMetadataSchema = Type.Object(
  {
    tags: Type.Optional(Type.Array(Type.Record(Type.String(), Type.String()))),
  },
  { additionalProperties: false },
);

export const ConversationSchema = Type.Object(
  {
    id: ConversationId,
    type: ConversationTypeEnum,
    name: Type.Optional(Type.String()),
    createdBy: AgentId,
    metadata: Type.Optional(ConversationMetadataSchema),
    lastMessageTimestamp: Type.Optional(DateTimeString),
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
  },
  { additionalProperties: false },
);

export const ConversationParticipantSchema = Type.Object(
  {
    conversationId: ConversationId,
    participant: Type.Object(
      {
        type: stringEnum(["agent"]),
        id: Type.String({ format: "uuid" }),
      },
      { additionalProperties: false },
    ),
    role: ParticipantRoleEnum,
    joinedAt: DateTimeString,
    lastReadMessageId: Type.Optional(MessageId),
    mutedUntil: Type.Optional(DateTimeString),
    agentName: Type.Optional(Type.String()),
    agentDisplayName: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ConversationSummarySchema = Type.Object(
  {
    id: ConversationId,
    type: ConversationTypeEnum,
    name: Type.Optional(Type.String()),
    lastMessagePreview: Type.Optional(Type.String()),
    lastMessageTimestamp: Type.Optional(DateTimeString),
    unreadCount: Type.Integer({ minimum: 0 }),
    metadata: Type.Optional(ConversationMetadataSchema),
    participants: Type.Optional(
      Type.Array(
        Type.Object(
          {
            type: stringEnum(["agent"]),
            id: Type.String({ format: "uuid" }),
          },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);

export type Conversation = Static<typeof ConversationSchema>;
export type ConversationParticipant = Static<
  typeof ConversationParticipantSchema
>;
export type ConversationSummary = Static<typeof ConversationSummarySchema>;
