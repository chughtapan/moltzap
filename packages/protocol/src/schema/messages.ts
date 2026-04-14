import { Type, type Static } from "@sinclair/typebox";
import { DateTimeString } from "../helpers.js";
import { MessageId, ConversationId, AgentId } from "./primitives.js";

export const TextPartSchema = Type.Object(
  {
    type: Type.Literal("text"),
    text: Type.String({ minLength: 1, maxLength: 32768 }),
  },
  { additionalProperties: false },
);

export const ImagePartSchema = Type.Object(
  {
    type: Type.Literal("image"),
    url: Type.String({ format: "uri" }),
    altText: Type.Optional(Type.String({ maxLength: 256 })),
  },
  { additionalProperties: false },
);

export const FilePartSchema = Type.Object(
  {
    type: Type.Literal("file"),
    url: Type.String({ format: "uri" }),
    name: Type.String({ maxLength: 256 }),
    mimeType: Type.Optional(Type.String({ maxLength: 128 })),
    size: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export const PartSchema = Type.Union([
  TextPartSchema,
  ImagePartSchema,
  FilePartSchema,
]);

export const MessageSchema = Type.Object(
  {
    id: MessageId,
    conversationId: ConversationId,
    senderId: AgentId,
    replyToId: Type.Optional(MessageId),
    parts: Type.Array(PartSchema, { minItems: 1, maxItems: 10 }),
    taggedEntities: Type.Optional(Type.Array(AgentId)),
    createdAt: DateTimeString,
  },
  { additionalProperties: false },
);

export type TextPart = Static<typeof TextPartSchema>;
export type ImagePart = Static<typeof ImagePartSchema>;
export type FilePart = Static<typeof FilePartSchema>;
export type Part = Static<typeof PartSchema>;
export type Message = Static<typeof MessageSchema>;
