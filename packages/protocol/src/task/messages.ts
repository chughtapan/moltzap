import { Type, type Static } from "@sinclair/typebox";
import { DateTimeString } from "../schema-primitives.js";
import { AgentId } from "../identity/agents.js";
import { defineRpc, defineNotification } from "../transport/method.js";
import { ConversationId, MessageId } from "./conversations.js";

export const TextPartSchema = Type.Object(
  {
    type: Type.Literal("text"),
    text: Type.String({ minLength: 1, maxLength: 32768 }),
  },
  { additionalProperties: false },
);

const ImagePartSchema = Type.Object(
  {
    type: Type.Literal("image"),
    url: Type.String({ minLength: 1, format: "uri" }),
    altText: Type.Optional(Type.String({ maxLength: 256 })),
  },
  { additionalProperties: false },
);

const FilePartSchema = Type.Object(
  {
    type: Type.Literal("file"),
    url: Type.String({ minLength: 1, format: "uri" }),
    name: Type.String({ minLength: 1, maxLength: 256 }),
    mimeType: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    size: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

const PartSchema = Type.Union([
  TextPartSchema,
  ImagePartSchema,
  FilePartSchema,
]);

export type Part = Static<typeof PartSchema>;

export const MessagePartsSchema = Type.Array(PartSchema, {
  minItems: 1,
  maxItems: 10,
});

export const MessageSchema = Type.Object(
  {
    id: MessageId,
    conversationId: ConversationId,
    senderId: AgentId,
    replyToId: Type.Optional(MessageId),
    parts: MessagePartsSchema,
    taggedEntities: Type.Optional(Type.Array(AgentId)),
    patchedBy: Type.Optional(Type.String()),
    createdAt: DateTimeString,
  },
  { additionalProperties: false },
);

export type Message = Static<typeof MessageSchema>;

export const MessagesSend = defineRpc({
  name: "messages/send",
  params: Type.Object(
    {
      conversationId: Type.Optional(ConversationId),
      to: Type.Optional(Type.String()),
      parts: MessagePartsSchema,
      replyToId: Type.Optional(MessageId),
      dispatchLeaseId: Type.Optional(Type.String()),
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

const MessageReceivedNotificationSchema = Type.Object(
  { message: MessageSchema },
  { additionalProperties: false },
);

export type MessageReceivedNotification = Static<
  typeof MessageReceivedNotificationSchema
>;

export const MessageReceivedNotificationDefinition = defineNotification({
  name: "messages/received",
  params: MessageReceivedNotificationSchema,
});
