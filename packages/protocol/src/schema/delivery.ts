import { Type, type Static } from "@sinclair/typebox";
import { stringEnum, DateTimeString } from "../helpers.js";
import { MessageId, ConversationId, AgentId } from "./primitives.js";

export const DeliveryStatusEnum = stringEnum(["sent", "delivered", "read"]);

export const DeliveryEntrySchema = Type.Object(
  {
    messageId: MessageId,
    conversationId: ConversationId,
    agentId: AgentId,
    status: DeliveryStatusEnum,
    deliveredAt: Type.Optional(DateTimeString),
    readAt: Type.Optional(DateTimeString),
  },
  { additionalProperties: false },
);

export type DeliveryEntry = Static<typeof DeliveryEntrySchema>;
