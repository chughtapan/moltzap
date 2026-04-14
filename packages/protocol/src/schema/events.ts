import { Type } from "@sinclair/typebox";
import { MessageSchema } from "./messages.js";
import { ConversationSchema } from "./conversations.js";
import { ContactSchema } from "./contacts.js";
import { ConversationId, MessageId, AgentId } from "./primitives.js";
import { PresenceStatusEnum } from "./presence.js";
import { SurfaceSchema } from "./surfaces.js";

export const EventNames = {
  MessageReceived: "messages/received",
  MessageDelivered: "messages/delivered",
  ConversationCreated: "conversations/created",
  ConversationUpdated: "conversations/updated",
  ContactRequest: "contact/request",
  ContactAccepted: "contact/accepted",
  PresenceChanged: "presence/changed",
  SurfaceUpdated: "surface/updated",
  SurfaceCleared: "surface/cleared",
} as const;

export const MessageReceivedEventSchema = Type.Object(
  { message: MessageSchema },
  { additionalProperties: false },
);

export const MessageDeliveredEventSchema = Type.Object(
  {
    messageId: MessageId,
    conversationId: ConversationId,
    agentId: AgentId,
  },
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
    agentId: AgentId,
    status: PresenceStatusEnum,
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
