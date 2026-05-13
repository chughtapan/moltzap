import { Type, type Static } from "@sinclair/typebox";
import { dateTimeStringSchema } from "../schema-primitives.js";
import { AgentId } from "../identity/agents.js";
import { defineRpc, defineNotification } from "../transport/method.js";
import { ajv } from "../transport/wire.js";
import { ConversationId, MessageId } from "./conversations.js";

const DateTimeString = dateTimeStringSchema();

const TextPartSchema = Type.Object(
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

const MessagePartsSchema = Type.Array(PartSchema, {
  minItems: 1,
  maxItems: 10,
});

const MessageSchema = Type.Object(
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

export const validateTextPart = ajv.compile(TextPartSchema) as (
  value: unknown,
) => value is Static<typeof TextPartSchema>;
export const validateMessage = ajv.compile(MessageSchema) as (
  value: unknown,
) => value is Message;

export function messagePartsSchema(): typeof MessagePartsSchema {
  return MessagePartsSchema;
}

export function messageSchema(): typeof MessageSchema {
  return MessageSchema;
}

// ── tm_decision (#560) ──────────────────────────────────────────────
//
// Per-message TM fan-out verdict. Lives on `messages.tm_decision`
// jsonb column server-side. Wire exposure is TM-caller-only:
//
// - `MessageSchema` (above) stays the canonical shape for non-TM
//   callers — sender, recipient, any other agent. It does NOT carry
//   `tm_decision`. Recipients see only `forward` rows where they
//   appear in `recipients` (filter applied server-side); they have
//   no need to inspect the verdict.
// - `MessageWithTmDecisionSchema` (below) extends `MessageSchema`
//   with the verdict. The TM caller for a task sees this shape.
//
// Architect plan §3 picks two-schema (this file) over runtime-strip
// (single optional field) to keep TS strict at non-TM read sites:
// non-TM consumers literally cannot reference `tmDecision` because
// the field is not in their type. See #560 architect comment §3
// + risk R8 for the alternative.

const TmDecisionSchema = Type.Union([
  Type.Object(
    { tag: Type.Literal("pending") },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      tag: Type.Literal("forward"),
      recipients: Type.Array(AgentId),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      tag: Type.Literal("block"),
      reason: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
]);

export type TmDecision = Static<typeof TmDecisionSchema>;

const MessageWithTmDecisionSchema = Type.Composite([
  MessageSchema,
  Type.Object(
    { tmDecision: TmDecisionSchema },
    { additionalProperties: false },
  ),
]);

export type MessageWithTmDecision = Static<typeof MessageWithTmDecisionSchema>;

export function tmDecisionSchema(): typeof TmDecisionSchema {
  return TmDecisionSchema;
}

export function messageWithTmDecisionSchema(): typeof MessageWithTmDecisionSchema {
  return MessageWithTmDecisionSchema;
}

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
