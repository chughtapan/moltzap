import { Type, type Static } from "@sinclair/typebox";
import { stringEnum, DateTimeString } from "../../helpers.js";
import { ConversationId } from "../primitives.js";
import {
  ConversationSchema,
  ConversationTypeEnum,
  ConversationParticipantSchema,
  ConversationSummarySchema,
} from "../conversations.js";

const AgentParticipantSchema = Type.Object(
  {
    type: stringEnum(["agent"]),
    id: Type.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);

export const ConversationsCreateParamsSchema = Type.Object(
  {
    type: ConversationTypeEnum,
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    participants: Type.Array(AgentParticipantSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

export const ConversationsCreateResultSchema = Type.Object(
  { conversation: ConversationSchema },
  { additionalProperties: false },
);

export const ConversationsListParamsSchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ConversationsListResultSchema = Type.Object(
  {
    conversations: Type.Array(ConversationSummarySchema),
    cursor: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ConversationsGetParamsSchema = Type.Object(
  { conversationId: ConversationId },
  { additionalProperties: false },
);

export const ConversationsGetResultSchema = Type.Object(
  {
    conversation: ConversationSchema,
    participants: Type.Array(ConversationParticipantSchema),
  },
  { additionalProperties: false },
);

export const ConversationsUpdateParamsSchema = Type.Object(
  {
    conversationId: ConversationId,
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { additionalProperties: false },
);

export const ConversationsMuteParamsSchema = Type.Object(
  {
    conversationId: ConversationId,
    until: Type.Optional(DateTimeString),
  },
  { additionalProperties: false },
);

export const ConversationsAddParticipantParamsSchema = Type.Object(
  {
    conversationId: ConversationId,
    participant: AgentParticipantSchema,
  },
  { additionalProperties: false },
);

export const ConversationsRemoveParticipantParamsSchema = Type.Object(
  {
    conversationId: ConversationId,
    participant: AgentParticipantSchema,
  },
  { additionalProperties: false },
);

export const ConversationsLeaveParamsSchema = Type.Object(
  { conversationId: ConversationId },
  { additionalProperties: false },
);

export const ConversationsUnmuteParamsSchema = Type.Object(
  { conversationId: ConversationId },
  { additionalProperties: false },
);

export type ConversationsCreateParams = Static<
  typeof ConversationsCreateParamsSchema
>;
export type ConversationsCreateResult = Static<
  typeof ConversationsCreateResultSchema
>;
export type ConversationsListParams = Static<
  typeof ConversationsListParamsSchema
>;
export type ConversationsListResult = Static<
  typeof ConversationsListResultSchema
>;
export type ConversationsGetParams = Static<
  typeof ConversationsGetParamsSchema
>;
export type ConversationsGetResult = Static<
  typeof ConversationsGetResultSchema
>;
export type ConversationsUpdateParams = Static<
  typeof ConversationsUpdateParamsSchema
>;
export type ConversationsMuteParams = Static<
  typeof ConversationsMuteParamsSchema
>;
export type ConversationsAddParticipantParams = Static<
  typeof ConversationsAddParticipantParamsSchema
>;
export type ConversationsRemoveParticipantParams = Static<
  typeof ConversationsRemoveParticipantParamsSchema
>;
export type ConversationsLeaveParams = Static<
  typeof ConversationsLeaveParamsSchema
>;
export type ConversationsUnmuteParams = Static<
  typeof ConversationsUnmuteParamsSchema
>;
