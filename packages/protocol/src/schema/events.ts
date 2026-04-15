import { Type } from "@sinclair/typebox";
import { MessageSchema } from "./messages.js";
import { ConversationSchema } from "./conversations.js";
import { ContactSchema } from "./contacts.js";
import { ConversationId, MessageId, AgentId } from "./primitives.js";
import { PresenceStatusEnum } from "./presence.js";
import { SurfaceSchema } from "./surfaces.js";
import { AppSessionId } from "./apps.js";
import { stringEnum } from "../helpers.js";

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
  AppSkillChallenge: "app/skillChallenge",
  AppPermissionRequest: "app/permissionRequest",
  AppParticipantAdmitted: "app/participantAdmitted",
  AppParticipantRejected: "app/participantRejected",
  AppSessionReady: "app/sessionReady",
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

// App events

export const AppSkillChallengeEventSchema = Type.Object(
  {
    challengeId: Type.String({ format: "uuid" }),
    sessionId: AppSessionId,
    appId: Type.String(),
    skillUrl: Type.String(),
    minVersion: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AppPermissionRequestEventSchema = Type.Object(
  {
    sessionId: AppSessionId,
    appId: Type.String(),
    resource: Type.String(),
    access: Type.Array(Type.String()),
    requestId: Type.String({ format: "uuid" }),
    targetUserId: Type.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);

export const AppParticipantAdmittedEventSchema = Type.Object(
  {
    sessionId: AppSessionId,
    agentId: AgentId,
    grantedResources: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const AppParticipantRejectedEventSchema = Type.Object(
  {
    sessionId: AppSessionId,
    agentId: AgentId,
    reason: Type.String(),
    stage: stringEnum(["identity", "capability", "permission"]),
    suggestedAction: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const AppSessionReadyEventSchema = Type.Object(
  {
    sessionId: AppSessionId,
    conversations: Type.Record(Type.String(), ConversationId),
  },
  { additionalProperties: false },
);
