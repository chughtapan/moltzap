import { Type, type Static } from "@sinclair/typebox";
import { MessageSchema } from "./messages.js";
import { ConversationSchema } from "./conversations.js";
import { ContactSchema } from "./contacts.js";
import { ConversationId, MessageId, AgentId } from "./primitives.js";
import { PresenceStatusEnum } from "./presence.js";
import { SurfaceSchema } from "./surfaces.js";
import { AppSessionId } from "./apps.js";
import { stringEnum, DateTimeString } from "../helpers.js";

export const EventNames = {
  MessageReceived: "messages/received",
  MessageDelivered: "messages/delivered",
  ConversationCreated: "conversations/created",
  ConversationUpdated: "conversations/updated",
  ConversationArchived: "conversations/archived",
  ConversationUnarchived: "conversations/unarchived",
  ContactRequest: "contact/request",
  ContactAccepted: "contact/accepted",
  PresenceChanged: "presence/changed",
  SurfaceUpdated: "surface/updated",
  SurfaceCleared: "surface/cleared",
  AppSkillChallenge: "app/skillChallenge",
  PermissionsRequired: "permissions/required",
  AppParticipantAdmitted: "app/participantAdmitted",
  AppParticipantRejected: "app/participantRejected",
  AppSessionReady: "app/sessionReady",
  AppSessionFailed: "app/sessionFailed",
  AppSessionClosed: "app/sessionClosed",
  AppHookTimeout: "app/hookTimeout",
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

export const ConversationArchivedEventSchema = Type.Object(
  {
    conversationId: ConversationId,
    archivedAt: DateTimeString,
    by: AgentId,
  },
  { additionalProperties: false },
);

export const ConversationUnarchivedEventSchema = Type.Object(
  {
    conversationId: ConversationId,
    by: AgentId,
  },
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

export const PermissionsRequiredEventSchema = Type.Object(
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
    stage: stringEnum(["user", "identity", "capability", "permission"]),
    suggestedAction: Type.Optional(Type.String()),
    rejectionCode: stringEnum([
      "UserInvalid",
      "UserValidationFailed",
      "AgentNotFound",
      "AgentNoOwner",
      "NotInContacts",
      "ContactCheckFailed",
      "AttestationTimeout",
      "SkillMismatch",
      "SkillVersionTooOld",
      "PermissionDenied",
      "PermissionTimeout",
      "PermissionHandlerError",
      "NoPermissionHandler",
    ]),
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

export const AppSessionFailedEventSchema = Type.Object(
  {
    sessionId: AppSessionId,
  },
  { additionalProperties: false },
);

export const AppSessionClosedEventSchema = Type.Object(
  {
    sessionId: AppSessionId,
    closedBy: AgentId,
  },
  { additionalProperties: false },
);

export const AppHookTimeoutEventSchema = Type.Object(
  {
    sessionId: AppSessionId,
    appId: Type.String(),
    hookName: stringEnum(["before_message_delivery", "on_join", "on_close"]),
    timeoutMs: Type.Integer(),
  },
  { additionalProperties: false },
);

export type MessageReceivedEvent = Static<typeof MessageReceivedEventSchema>;
export type MessageDeliveredEvent = Static<typeof MessageDeliveredEventSchema>;
export type ConversationCreatedEvent = Static<
  typeof ConversationCreatedEventSchema
>;
export type ConversationUpdatedEvent = Static<
  typeof ConversationUpdatedEventSchema
>;
export type ConversationArchivedEvent = Static<
  typeof ConversationArchivedEventSchema
>;
export type ConversationUnarchivedEvent = Static<
  typeof ConversationUnarchivedEventSchema
>;
export type ContactRequestEvent = Static<typeof ContactRequestEventSchema>;
export type ContactAcceptedEvent = Static<typeof ContactAcceptedEventSchema>;
export type PresenceChangedEvent = Static<typeof PresenceChangedEventSchema>;
export type SurfaceUpdatedEvent = Static<typeof SurfaceUpdatedEventSchema>;
export type SurfaceClearedEvent = Static<typeof SurfaceClearedEventSchema>;
export type AppSkillChallengeEvent = Static<
  typeof AppSkillChallengeEventSchema
>;
export type PermissionsRequiredEvent = Static<
  typeof PermissionsRequiredEventSchema
>;
export type AppParticipantAdmittedEvent = Static<
  typeof AppParticipantAdmittedEventSchema
>;
export type AppParticipantRejectedEvent = Static<
  typeof AppParticipantRejectedEventSchema
>;
export type AppSessionReadyEvent = Static<typeof AppSessionReadyEventSchema>;
export type AppSessionFailedEvent = Static<typeof AppSessionFailedEventSchema>;
export type AppSessionClosedEvent = Static<typeof AppSessionClosedEventSchema>;
export type AppHookTimeoutEvent = Static<typeof AppHookTimeoutEventSchema>;
