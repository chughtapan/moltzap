import { Type, type Static } from "@sinclair/typebox";
import { stringEnum } from "../../helpers.js";
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
    afterSeq: Type.Optional(Type.Integer({ minimum: 0 })),
    beforeSeq: Type.Optional(Type.Integer({ minimum: 0 })),
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

export const MessagesReadParamsSchema = Type.Object(
  {
    conversationId: ConversationId,
    seq: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const MessagesReactParamsSchema = Type.Object(
  {
    messageId: MessageId,
    emoji: Type.String({ minLength: 1, maxLength: 32 }),
    action: stringEnum(["add", "remove"]),
  },
  { additionalProperties: false },
);

export const MessagesDeleteParamsSchema = Type.Object(
  { messageId: MessageId },
  { additionalProperties: false },
);

export type MessagesSendParams = Static<typeof MessagesSendParamsSchema>;
export type MessagesSendResult = Static<typeof MessagesSendResultSchema>;
export type MessagesListParams = Static<typeof MessagesListParamsSchema>;
export type MessagesListResult = Static<typeof MessagesListResultSchema>;
export type MessagesReadParams = Static<typeof MessagesReadParamsSchema>;
export type MessagesReactParams = Static<typeof MessagesReactParamsSchema>;
export type MessagesDeleteParams = Static<typeof MessagesDeleteParamsSchema>;
