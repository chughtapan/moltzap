import { Type, type Static } from "@sinclair/typebox";
import { stringEnum, DateTimeString } from "../helpers.js";
import { ConversationId } from "./primitives.js";
import { ParticipantRefSchema } from "./identity.js";

export const ConversationTypeEnum = stringEnum(["dm", "group"]);
export const ParticipantRoleEnum = stringEnum(["owner", "admin", "member"]);

export const ConversationSchema = Type.Object(
  {
    id: ConversationId,
    type: ConversationTypeEnum,
    name: Type.Optional(Type.String()),
    createdBy: ParticipantRefSchema,
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
  },
  { additionalProperties: false },
);

export const ConversationParticipantSchema = Type.Object(
  {
    conversationId: ConversationId,
    participant: ParticipantRefSchema,
    role: ParticipantRoleEnum,
    joinedAt: DateTimeString,
    lastReadSeq: Type.Integer({ minimum: 0 }),
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
    lastMessageAt: Type.Optional(DateTimeString),
    unreadCount: Type.Integer({ minimum: 0 }),
    participants: Type.Optional(Type.Array(ParticipantRefSchema)),
  },
  { additionalProperties: false },
);

export type Conversation = Static<typeof ConversationSchema>;
export type ConversationParticipant = Static<
  typeof ConversationParticipantSchema
>;
export type ConversationSummary = Static<typeof ConversationSummarySchema>;
