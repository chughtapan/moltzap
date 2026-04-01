import { Type, type Static } from "@sinclair/typebox";
import { DateTimeString } from "../helpers.js";
import { MessageId, ConversationId } from "./primitives.js";
import { ParticipantRefSchema } from "./identity.js";

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
    sender: ParticipantRefSchema,
    seq: Type.Integer({ minimum: 1 }),
    replyToId: Type.Optional(MessageId),
    parts: Type.Array(PartSchema, { minItems: 1, maxItems: 10 }),
    reactions: Type.Optional(
      Type.Record(Type.String({ maxLength: 32 }), Type.Array(Type.String())),
    ),
    isDeleted: Type.Optional(Type.Boolean()),
    createdAt: DateTimeString,
  },
  { additionalProperties: false },
);

export type TextPart = Static<typeof TextPartSchema>;
export type ImagePart = Static<typeof ImagePartSchema>;
export type FilePart = Static<typeof FilePartSchema>;
export type Part = Static<typeof PartSchema>;
export type Message = Static<typeof MessageSchema>;
