import { Type, type Static } from "@sinclair/typebox";
import { MessageSchema } from "./messages.js";
import { ConversationSchema } from "./conversations.js";
import { ContactSchema } from "./contacts.js";
import { ConversationId, AgentId, TaskId } from "./primitives.js";
import { PresenceStatusEnum } from "./presence.js";
import { stringEnum, DateTimeString } from "../helpers.js";
import { jsonRpcMethod } from "./json-rpc.js";
import { defineNotification } from "../notification.js";
import {
  defineNotificationGroup,
  type RawDecodedNotification,
  type UnknownDecodedNotification,
} from "../rpc-groups.js";
import { LifecycleAgentSchema } from "../app/methods/apps.js";

const notificationNames = {
  MessageReceived: jsonRpcMethod("messages/received"),
  ConversationCreated: jsonRpcMethod("conversations/created"),
  ConversationUpdated: jsonRpcMethod("conversations/updated"),
  ConversationArchived: jsonRpcMethod("conversations/archived"),
  ConversationUnarchived: jsonRpcMethod("conversations/unarchived"),
  ContactRequest: jsonRpcMethod("contact/request"),
  ContactAccepted: jsonRpcMethod("contact/accepted"),
  PresenceChanged: jsonRpcMethod("presence/changed"),
  AppParticipantAdmitted: jsonRpcMethod("app/participantAdmitted"),
  AppParticipantRejected: jsonRpcMethod("app/participantRejected"),
  TaskReady: jsonRpcMethod("task/ready"),
  TaskFailed: jsonRpcMethod("task/failed"),
  TaskClosed: jsonRpcMethod("task/closed"),
  TaskAdmissionComplete: jsonRpcMethod("task/admissionComplete"),
} as const;

export const MessageReceivedNotificationSchema = Type.Object(
  { message: MessageSchema },
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

// App-admission notifications. Field name `taskId` (not `sessionId`) since
// Phase 7 dropped the `app_sessions` schema and renamed `AppSessionId →
// TaskId`. The notification names keep the `app/` prefix because admission
// is an app-framework concern; the lifecycle notifications below use the
// `task/` prefix per plan §2.9.

export const AppParticipantAdmittedNotificationSchema = Type.Object(
  {
    taskId: TaskId,
    agentId: AgentId,
  },
  { additionalProperties: false },
);

export const AppParticipantRejectedNotificationSchema = Type.Object(
  {
    taskId: TaskId,
    agentId: AgentId,
    reason: Type.String(),
    stage: stringEnum(["user", "identity"]),
    suggestedAction: Type.Optional(Type.String()),
    rejectionCode: stringEnum([
      "UserInvalid",
      "UserValidationFailed",
      "AgentNotFound",
      "AgentNoOwner",
      "NotInContacts",
      "ContactCheckFailed",
    ]),
  },
  { additionalProperties: false },
);

// Task lifecycle notifications (renamed from app/sessionX in Phase 7 per
// plan §2.9). Same wire payload as the prior app/sessionReady and
// app/sessionFailed; task/closed augments the prior app/sessionClosed
// payload with `conversations` and the closer's `ownerId`.

export const TaskReadyNotificationSchema = Type.Object(
  {
    taskId: TaskId,
    conversations: Type.Record(Type.String(), ConversationId),
  },
  { additionalProperties: false },
);

export const TaskFailedNotificationSchema = Type.Object(
  {
    taskId: TaskId,
  },
  { additionalProperties: false },
);

export const TaskClosedNotificationSchema = Type.Object(
  {
    taskId: TaskId,
    conversations: Type.Record(Type.String(), ConversationId),
    // `closedBy` reuses {@link LifecycleAgentSchema} so the closer
    // payload stays a single shape on the wire. Phase 9b retired the
    // `apps/onClose` hook context that previously co-owned the schema;
    // the schema is now uniquely owned by this notification.
    closedBy: LifecycleAgentSchema,
  },
  { additionalProperties: false },
);

// Server → TM notification per plan §2.9. Fires after admission completes,
// before `task/ready` reaches the participants. Carries the agent ids the
// server admitted so the TM can begin its setup phase with full membership
// already known. In Phase 7 the TM endpoint may be unregistered; in that
// case the notification is dropped.

export const TaskAdmissionCompleteNotificationSchema = Type.Object(
  {
    taskId: TaskId,
    admittedAgentIds: Type.Array(AgentId),
  },
  { additionalProperties: false },
);

export type MessageReceivedNotification = Static<
  typeof MessageReceivedNotificationSchema
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
export type AppParticipantAdmittedNotification = Static<
  typeof AppParticipantAdmittedNotificationSchema
>;
export type AppParticipantRejectedNotification = Static<
  typeof AppParticipantRejectedNotificationSchema
>;
export type TaskReadyNotification = Static<typeof TaskReadyNotificationSchema>;
export type TaskFailedNotification = Static<
  typeof TaskFailedNotificationSchema
>;
export type TaskClosedNotification = Static<
  typeof TaskClosedNotificationSchema
>;
export type TaskAdmissionCompleteNotification = Static<
  typeof TaskAdmissionCompleteNotificationSchema
>;

export const MessageReceivedNotificationDefinition = defineNotification({
  name: notificationNames.MessageReceived,
  params: MessageReceivedNotificationSchema,
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

export const AppParticipantAdmittedNotificationDefinition = defineNotification({
  name: notificationNames.AppParticipantAdmitted,
  params: AppParticipantAdmittedNotificationSchema,
});

export const AppParticipantRejectedNotificationDefinition = defineNotification({
  name: notificationNames.AppParticipantRejected,
  params: AppParticipantRejectedNotificationSchema,
});

export const TaskReadyNotificationDefinition = defineNotification({
  name: notificationNames.TaskReady,
  params: TaskReadyNotificationSchema,
});

export const TaskFailedNotificationDefinition = defineNotification({
  name: notificationNames.TaskFailed,
  params: TaskFailedNotificationSchema,
});

export const TaskClosedNotificationDefinition = defineNotification({
  name: notificationNames.TaskClosed,
  params: TaskClosedNotificationSchema,
});

export const TaskAdmissionCompleteNotificationDefinition = defineNotification({
  name: notificationNames.TaskAdmissionComplete,
  params: TaskAdmissionCompleteNotificationSchema,
});

export const notificationDefinitions = [
  MessageReceivedNotificationDefinition,
  ConversationCreatedNotificationDefinition,
  ConversationUpdatedNotificationDefinition,
  ConversationArchivedNotificationDefinition,
  ConversationUnarchivedNotificationDefinition,
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
  PresenceChangedNotificationDefinition,
  AppParticipantAdmittedNotificationDefinition,
  AppParticipantRejectedNotificationDefinition,
  TaskReadyNotificationDefinition,
  TaskFailedNotificationDefinition,
  TaskClosedNotificationDefinition,
  TaskAdmissionCompleteNotificationDefinition,
] as const;

export const notificationGroup = defineNotificationGroup(
  "notification",
  notificationDefinitions,
);

export type AnyNotificationDefinition =
  (typeof notificationDefinitions)[number];

export type NotificationMethodName = AnyNotificationDefinition["name"];

/**
 * Discriminated union emitted by the client wire decoder for any
 * inbound notification frame: a known method (descriptor attached,
 * `params: unknown` until validated) or an unknown method (no
 * descriptor). The consumer-facing union for `subscribers.dispatch`,
 * the `notificationsBufferRef` queue, and `MoltZapService.handleNotification`
 * — production typed handlers narrow this into `DecodedNotification<D>`
 * via the typed-bridge lift (`validateNotificationParams`).
 *
 * Specialized over the closed `AnyNotificationDefinition` union so the
 * Raw branch distributes per descriptor; the discriminator is the
 * `definition` field (present + typed for known, absent on unknown).
 */
export type DecodedNotificationFrame =
  | RawDecodedNotification<AnyNotificationDefinition>
  | UnknownDecodedNotification;
