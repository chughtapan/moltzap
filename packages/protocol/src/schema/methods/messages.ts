import { Type } from "@sinclair/typebox";
import { ConversationId, MessageId } from "../primitives.js";
import { MessageSchema, PartSchema } from "../messages.js";
import { defineRpc } from "../../rpc.js";

export const MessagesSend = defineRpc({
  name: "messages/send",
  params: Type.Object(
    {
      conversationId: Type.Optional(ConversationId),
      to: Type.Optional(Type.String()),
      parts: Type.Array(PartSchema, { minItems: 1, maxItems: 10 }),
      replyToId: Type.Optional(MessageId),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { message: MessageSchema },
    { additionalProperties: false },
  ),
});

export const MessagesList = defineRpc({
  name: "messages/list",
  params: Type.Object(
    {
      conversationId: ConversationId,
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      messages: Type.Array(MessageSchema),
      hasMore: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
});
