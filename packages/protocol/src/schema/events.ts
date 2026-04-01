import { Type } from "@sinclair/typebox";
import { stringEnum } from "../helpers.js";
import { MessageSchema } from "./messages.js";
import { ConversationSchema } from "./conversations.js";
import { ContactSchema } from "./contacts.js";
import { ConversationId, MessageId } from "./primitives.js";
import { ParticipantRefSchema } from "./identity.js";
import { PresenceStatusEnum } from "./presence.js";
import { SurfaceSchema } from "./surfaces.js";

export const EventNames = {
  MessageReceived: "messages/received",
  MessageRead: "messages/read",
  MessageReacted: "messages/reacted",
  MessageDelivered: "messages/delivered",
  MessageDeleted: "messages/deleted",
  ConversationCreated: "conversations/created",
  ConversationUpdated: "conversations/updated",
  ContactRequest: "contact/request",
  ContactAccepted: "contact/accepted",
  PresenceChanged: "presence/changed",
  TypingIndicator: "typing/indicator",
  SurfaceUpdated: "surface/updated",
  SurfaceCleared: "surface/cleared",
} as const;

export const MessageReceivedEventSchema = Type.Object(
  { message: MessageSchema },
  { additionalProperties: false },
);

export const MessageReadEventSchema = Type.Object(
  {
    conversationId: ConversationId,
    participant: ParticipantRefSchema,
    seq: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export const MessageReactedEventSchema = Type.Object(
  {
    messageId: MessageId,
    emoji: Type.String(),
    participant: ParticipantRefSchema,
    action: stringEnum(["add", "remove"]),
  },
  { additionalProperties: false },
);

export const MessageDeliveredEventSchema = Type.Object(
  {
    messageId: MessageId,
    conversationId: ConversationId,
    participant: ParticipantRefSchema,
  },
  { additionalProperties: false },
);

export const MessageDeletedEventSchema = Type.Object(
  { messageId: MessageId, conversationId: ConversationId },
  { additionalProperties: false },
);

export const ConversationCreatedEventSchema = Type.Object(
  { conversation: ConversationSchema },
  { additionalProperties: false },
);

export const ConversationUpdatedEventSchema = Type.Object(
  { conversation: ConversationSchema },
  { additionalProperties: false },
);

export const ContactRequestEventSchema = Type.Object(
  { contact: ContactSchema },
  { additionalProperties: false },
);

export const ContactAcceptedEventSchema = Type.Object(
  { contact: ContactSchema },
  { additionalProperties: false },
);

export const PresenceChangedEventSchema = Type.Object(
  {
    participant: ParticipantRefSchema,
    status: PresenceStatusEnum,
  },
  { additionalProperties: false },
);

export const TypingIndicatorEventSchema = Type.Object(
  {
    conversationId: ConversationId,
    participant: ParticipantRefSchema,
  },
  { additionalProperties: false },
);

export const SurfaceUpdatedEventSchema = Type.Object(
  { surface: SurfaceSchema },
  { additionalProperties: false },
);

export const SurfaceClearedEventSchema = Type.Object(
  { conversationId: ConversationId },
  { additionalProperties: false },
);
