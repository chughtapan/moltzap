import { Type, type Static } from "@sinclair/typebox";
import { MessageSchema } from "./messages.js";
import { ConversationSchema } from "./conversations.js";
import { ContactSchema } from "./contacts.js";
import { ConversationId, MessageId, AgentId } from "./primitives.js";
import { PresenceStatusEnum } from "./presence.js";
import { SurfaceSchema } from "./surfaces.js";
import { AppSessionId } from "./apps.js";
import { stringEnum, DateTimeString } from "../helpers.js";
import { jsonRpcMethod } from "./json-rpc.js";
import { defineNotification } from "../notification.js";
import { defineNotificationGroup } from "../rpc-groups.js";

const notificationNames = {
  MessageReceived: jsonRpcMethod("messages/received"),
  MessageDelivered: jsonRpcMethod("messages/delivered"),
  ConversationCreated: jsonRpcMethod("conversations/created"),
  ConversationUpdated: jsonRpcMethod("conversations/updated"),
  ConversationArchived: jsonRpcMethod("conversations/archived"),
  ConversationUnarchived: jsonRpcMethod("conversations/unarchived"),
  ContactRequest: jsonRpcMethod("contact/request"),
  ContactAccepted: jsonRpcMethod("contact/accepted"),
  PresenceChanged: jsonRpcMethod("presence/changed"),
  SurfaceUpdated: jsonRpcMethod("surface/updated"),
  SurfaceCleared: jsonRpcMethod("surface/cleared"),
  AppSkillChallenge: jsonRpcMethod("app/skillChallenge"),
  PermissionsRequired: jsonRpcMethod("permissions/required"),
  AppParticipantAdmitted: jsonRpcMethod("app/participantAdmitted"),
  AppParticipantRejected: jsonRpcMethod("app/participantRejected"),
  AppSessionReady: jsonRpcMethod("app/sessionReady"),
  AppSessionFailed: jsonRpcMethod("app/sessionFailed"),
  AppSessionClosed: jsonRpcMethod("app/sessionClosed"),
  AppHookTimeout: jsonRpcMethod("app/hookTimeout"),
} as const;

export const MessageReceivedNotificationSchema = Type.Object(
  { message: MessageSchema },
  { additionalProperties: false },
);

export const MessageDeliveredNotificationSchema = Type.Object(
  {
    messageId: MessageId,
    conversationId: ConversationId,
    agentId: AgentId,
  },
  { additionalProperties: false },
);

export const ConversationCreatedNotificationSchema = Type.Object(
  { conversation: ConversationSchema },
  { additionalProperties: false },
);

export const ConversationUpdatedNotificationSchema = Type.Object(
  { conversation: ConversationSchema },
  { additionalProperties: false },
);

export const ConversationArchivedNotificationSchema = Type.Object(
  {
    conversationId: ConversationId,
    archivedAt: DateTimeString,
    by: AgentId,
  },
  { additionalProperties: false },
);

export const ConversationUnarchivedNotificationSchema = Type.Object(
  {
    conversationId: ConversationId,
    by: AgentId,
  },
  { additionalProperties: false },
);

export const ContactRequestNotificationSchema = Type.Object(
  { contact: ContactSchema },
  { additionalProperties: false },
);

export const ContactAcceptedNotificationSchema = Type.Object(
  { contact: ContactSchema },
  { additionalProperties: false },
);

export const PresenceChangedNotificationSchema = Type.Object(
  {
    agentId: AgentId,
    status: PresenceStatusEnum,
  },
  { additionalProperties: false },
);

export const SurfaceUpdatedNotificationSchema = Type.Object(
  { surface: SurfaceSchema },
  { additionalProperties: false },
);

export const SurfaceClearedNotificationSchema = Type.Object(
  { conversationId: ConversationId },
  { additionalProperties: false },
);

// App notifications

export const AppSkillChallengeNotificationSchema = Type.Object(
  {
    challengeId: Type.String({ format: "uuid" }),
    sessionId: AppSessionId,
    appId: Type.String(),
    skillUrl: Type.String(),
    minVersion: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const PermissionsRequiredNotificationSchema = Type.Object(
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

export const AppParticipantAdmittedNotificationSchema = Type.Object(
  {
    sessionId: AppSessionId,
    agentId: AgentId,
    grantedResources: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const AppParticipantRejectedNotificationSchema = Type.Object(
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

export const AppSessionReadyNotificationSchema = Type.Object(
  {
    sessionId: AppSessionId,
    conversations: Type.Record(Type.String(), ConversationId),
  },
  { additionalProperties: false },
);

export const AppSessionFailedNotificationSchema = Type.Object(
  {
    sessionId: AppSessionId,
  },
  { additionalProperties: false },
);

export const AppSessionClosedNotificationSchema = Type.Object(
  {
    sessionId: AppSessionId,
    closedBy: AgentId,
  },
  { additionalProperties: false },
);

export const AppHookTimeoutNotificationSchema = Type.Object(
  {
    sessionId: AppSessionId,
    appId: Type.String(),
    hookName: stringEnum([
      "before_message_delivery",
      "before_dispatch",
      "on_join",
      "on_session_active",
      "on_close",
    ]),
    timeoutMs: Type.Integer(),
  },
  { additionalProperties: false },
);

export type MessageReceivedNotification = Static<
  typeof MessageReceivedNotificationSchema
>;
export type MessageDeliveredNotification = Static<
  typeof MessageDeliveredNotificationSchema
>;
export type ConversationCreatedNotification = Static<
  typeof ConversationCreatedNotificationSchema
>;
export type ConversationUpdatedNotification = Static<
  typeof ConversationUpdatedNotificationSchema
>;
export type ConversationArchivedNotification = Static<
  typeof ConversationArchivedNotificationSchema
>;
export type ConversationUnarchivedNotification = Static<
  typeof ConversationUnarchivedNotificationSchema
>;
export type ContactRequestNotification = Static<
  typeof ContactRequestNotificationSchema
>;
export type ContactAcceptedNotification = Static<
  typeof ContactAcceptedNotificationSchema
>;
export type PresenceChangedNotification = Static<
  typeof PresenceChangedNotificationSchema
>;
export type SurfaceUpdatedNotification = Static<
  typeof SurfaceUpdatedNotificationSchema
>;
export type SurfaceClearedNotification = Static<
  typeof SurfaceClearedNotificationSchema
>;
export type AppSkillChallengeNotification = Static<
  typeof AppSkillChallengeNotificationSchema
>;
export type PermissionsRequiredNotification = Static<
  typeof PermissionsRequiredNotificationSchema
>;
export type AppParticipantAdmittedNotification = Static<
  typeof AppParticipantAdmittedNotificationSchema
>;
export type AppParticipantRejectedNotification = Static<
  typeof AppParticipantRejectedNotificationSchema
>;
export type AppSessionReadyNotification = Static<
  typeof AppSessionReadyNotificationSchema
>;
export type AppSessionFailedNotification = Static<
  typeof AppSessionFailedNotificationSchema
>;
export type AppSessionClosedNotification = Static<
  typeof AppSessionClosedNotificationSchema
>;
export type AppHookTimeoutNotification = Static<
  typeof AppHookTimeoutNotificationSchema
>;

export const MessageReceivedNotificationDefinition = defineNotification({
  name: notificationNames.MessageReceived,
  params: MessageReceivedNotificationSchema,
});

export const MessageDeliveredNotificationDefinition = defineNotification({
  name: notificationNames.MessageDelivered,
  params: MessageDeliveredNotificationSchema,
});

export const ConversationCreatedNotificationDefinition = defineNotification({
  name: notificationNames.ConversationCreated,
  params: ConversationCreatedNotificationSchema,
});

export const ConversationUpdatedNotificationDefinition = defineNotification({
  name: notificationNames.ConversationUpdated,
  params: ConversationUpdatedNotificationSchema,
});

export const ConversationArchivedNotificationDefinition = defineNotification({
  name: notificationNames.ConversationArchived,
  params: ConversationArchivedNotificationSchema,
});

export const ConversationUnarchivedNotificationDefinition = defineNotification({
  name: notificationNames.ConversationUnarchived,
  params: ConversationUnarchivedNotificationSchema,
});

export const ContactRequestNotificationDefinition = defineNotification({
  name: notificationNames.ContactRequest,
  params: ContactRequestNotificationSchema,
});

export const ContactAcceptedNotificationDefinition = defineNotification({
  name: notificationNames.ContactAccepted,
  params: ContactAcceptedNotificationSchema,
});

export const PresenceChangedNotificationDefinition = defineNotification({
  name: notificationNames.PresenceChanged,
  params: PresenceChangedNotificationSchema,
});

export const SurfaceUpdatedNotificationDefinition = defineNotification({
  name: notificationNames.SurfaceUpdated,
  params: SurfaceUpdatedNotificationSchema,
});

export const SurfaceClearedNotificationDefinition = defineNotification({
  name: notificationNames.SurfaceCleared,
  params: SurfaceClearedNotificationSchema,
});

export const AppSkillChallengeNotificationDefinition = defineNotification({
  name: notificationNames.AppSkillChallenge,
  params: AppSkillChallengeNotificationSchema,
});

export const PermissionsRequiredNotificationDefinition = defineNotification({
  name: notificationNames.PermissionsRequired,
  params: PermissionsRequiredNotificationSchema,
});

export const AppParticipantAdmittedNotificationDefinition = defineNotification({
  name: notificationNames.AppParticipantAdmitted,
  params: AppParticipantAdmittedNotificationSchema,
});

export const AppParticipantRejectedNotificationDefinition = defineNotification({
  name: notificationNames.AppParticipantRejected,
  params: AppParticipantRejectedNotificationSchema,
});

export const AppSessionReadyNotificationDefinition = defineNotification({
  name: notificationNames.AppSessionReady,
  params: AppSessionReadyNotificationSchema,
});

export const AppSessionFailedNotificationDefinition = defineNotification({
  name: notificationNames.AppSessionFailed,
  params: AppSessionFailedNotificationSchema,
});

export const AppSessionClosedNotificationDefinition = defineNotification({
  name: notificationNames.AppSessionClosed,
  params: AppSessionClosedNotificationSchema,
});

export const AppHookTimeoutNotificationDefinition = defineNotification({
  name: notificationNames.AppHookTimeout,
  params: AppHookTimeoutNotificationSchema,
});

export const notificationDefinitions = [
  MessageReceivedNotificationDefinition,
  MessageDeliveredNotificationDefinition,
  ConversationCreatedNotificationDefinition,
  ConversationUpdatedNotificationDefinition,
  ConversationArchivedNotificationDefinition,
  ConversationUnarchivedNotificationDefinition,
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
  PresenceChangedNotificationDefinition,
  SurfaceUpdatedNotificationDefinition,
  SurfaceClearedNotificationDefinition,
  AppSkillChallengeNotificationDefinition,
  PermissionsRequiredNotificationDefinition,
  AppParticipantAdmittedNotificationDefinition,
  AppParticipantRejectedNotificationDefinition,
  AppSessionReadyNotificationDefinition,
  AppSessionFailedNotificationDefinition,
  AppSessionClosedNotificationDefinition,
  AppHookTimeoutNotificationDefinition,
] as const;

export const notificationGroup = defineNotificationGroup(
  "notification",
  notificationDefinitions,
);

export type AnyNotificationDefinition =
  (typeof notificationDefinitions)[number];

export type NotificationMethodName = AnyNotificationDefinition["name"];
