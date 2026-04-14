import { Type, type Static } from "@sinclair/typebox";
import { ConversationId, MessageId } from "../primitives.js";
import { MessageSchema, PartSchema } from "../messages.js";

export const MessagesSendParamsSchema = Type.Object(
  {
    conversationId: Type.Optional(ConversationId),
    to: Type.Optional(Type.String()),
    parts: Type.Array(PartSchema, { minItems: 1, maxItems: 10 }),
    replyToId: Type.Optional(MessageId),
  },
  { additionalProperties: false },
);

export const MessagesSendResultSchema = Type.Object(
  { message: MessageSchema },
  { additionalProperties: false },
);

export const MessagesListParamsSchema = Type.Object(
  {
    conversationId: ConversationId,
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

export const MessagesListResultSchema = Type.Object(
  {
    messages: Type.Array(MessageSchema),
    hasMore: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type MessagesSendParams = Static<typeof MessagesSendParamsSchema>;
export type MessagesSendResult = Static<typeof MessagesSendResultSchema>;
export type MessagesListParams = Static<typeof MessagesListParamsSchema>;
export type MessagesListResult = Static<typeof MessagesListResultSchema>;
