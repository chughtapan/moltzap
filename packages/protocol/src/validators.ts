import {
  RequestFrameSchema,
  ResponseFrameSchema,
  NotificationFrameSchema,
  type RequestFrame,
  type ResponseFrame,
  type NotificationFrame,
} from "./schema/index.js";
import { ajv } from "./internal/ajv.js";
import {
  Register,
  InviteAgent,
  Connect,
  SelectAgent,
  AgentsLookup,
  AgentsLookupByName,
  AgentsList,
} from "./network/methods/auth.js";
import { MessagesSend, MessagesList } from "./task/methods/messages.js";
import {
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactsById,
} from "./task/methods/contacts.js";
import {
  ConversationsCreate,
  ConversationsList,
  ConversationsGet,
  ConversationsUpdate,
  ConversationsMute,
  ConversationsAddParticipant,
  ConversationsRemoveParticipant,
  ConversationsLeave,
  ConversationsUnmute,
  ConversationsArchive,
  ConversationsUnarchive,
} from "./task/methods/conversations.js";
import { InvitesCreateAgent } from "./task/methods/invites.js";
import { PresenceUpdate, PresenceSubscribe } from "./task/methods/presence.js";
import {
  AppParticipantAdmittedNotificationDefinition,
  AppParticipantRejectedNotificationDefinition,
  TaskAdmissionCompleteNotificationDefinition,
  TaskClosedNotificationDefinition,
  TaskFailedNotificationDefinition,
  TaskReadyNotificationDefinition,
  ContactAcceptedNotificationDefinition,
  ContactRequestNotificationDefinition,
  ConversationArchivedNotificationDefinition,
  ConversationCreatedNotificationDefinition,
  ConversationUnarchivedNotificationDefinition,
  ConversationUpdatedNotificationDefinition,
  MessageDeliveredNotificationDefinition,
  MessageReceivedNotificationDefinition,
  PresenceChangedNotificationDefinition,
} from "./schema/notifications.js";
import { AppsRegister, AppsAuthorizeDispatch } from "./app/methods/apps.js";
import { SystemPing } from "./network/methods/system.js";

/**
 * Named validator table. Every RPC manifest's `validateParams` is re-exported
 * here under a stable `xxxParams` key. Frame validators and notification
 * payload validators live here because they are not request/response RPCs.
 */
export const validators = {
  // Frames.
  requestFrame: ajv.compile(RequestFrameSchema) as (
    value: unknown,
  ) => value is RequestFrame,
  responseFrame: ajv.compile(ResponseFrameSchema) as (
    value: unknown,
  ) => value is ResponseFrame,
  notificationFrame: ajv.compile(NotificationFrameSchema) as (
    value: unknown,
  ) => value is NotificationFrame,

  // Auth.
  registerParams: Register.validateParams,
  inviteAgentParams: InviteAgent.validateParams,
  connectParams: Connect.validateParams,
  selectAgentParams: SelectAgent.validateParams,
  agentsLookupParams: AgentsLookup.validateParams,
  agentsLookupByNameParams: AgentsLookupByName.validateParams,
  agentsListParams: AgentsList.validateParams,

  // Messages.
  messagesSendParams: MessagesSend.validateParams,
  messagesListParams: MessagesList.validateParams,

  // Contacts.
  contactsListParams: ContactsList.validateParams,
  contactsAddParams: ContactsAdd.validateParams,
  contactsAcceptParams: ContactsAccept.validateParams,
  contactsByIdParams: ContactsById.validateParams,

  // Conversations.
  conversationsCreateParams: ConversationsCreate.validateParams,
  conversationsListParams: ConversationsList.validateParams,
  conversationsGetParams: ConversationsGet.validateParams,
  conversationsUpdateParams: ConversationsUpdate.validateParams,
  conversationsMuteParams: ConversationsMute.validateParams,
  conversationsAddParticipantParams: ConversationsAddParticipant.validateParams,
  conversationsRemoveParticipantParams:
    ConversationsRemoveParticipant.validateParams,
  conversationsLeaveParams: ConversationsLeave.validateParams,
  conversationsUnmuteParams: ConversationsUnmute.validateParams,
  conversationsArchiveParams: ConversationsArchive.validateParams,
  conversationsUnarchiveParams: ConversationsUnarchive.validateParams,

  // Invites.
  invitesCreateAgentParams: InvitesCreateAgent.validateParams,

  // Presence.
  presenceUpdateParams: PresenceUpdate.validateParams,
  presenceSubscribeParams: PresenceSubscribe.validateParams,

  // Apps.
  appsRegisterParams: AppsRegister.validateParams,
  appsAuthorizeDispatchParams: AppsAuthorizeDispatch.validateParams,

  // System.
  systemPingParams: SystemPing.validateParams,

  // Notifications.
  messageReceivedNotification:
    MessageReceivedNotificationDefinition.validateParams,
  messageDeliveredNotification:
    MessageDeliveredNotificationDefinition.validateParams,
  conversationCreatedNotification:
    ConversationCreatedNotificationDefinition.validateParams,
  conversationUpdatedNotification:
    ConversationUpdatedNotificationDefinition.validateParams,
  conversationArchivedNotification:
    ConversationArchivedNotificationDefinition.validateParams,
  conversationUnarchivedNotification:
    ConversationUnarchivedNotificationDefinition.validateParams,
  contactRequestNotification:
    ContactRequestNotificationDefinition.validateParams,
  contactAcceptedNotification:
    ContactAcceptedNotificationDefinition.validateParams,
  presenceChangedNotification:
    PresenceChangedNotificationDefinition.validateParams,
  appParticipantAdmittedNotification:
    AppParticipantAdmittedNotificationDefinition.validateParams,
  appParticipantRejectedNotification:
    AppParticipantRejectedNotificationDefinition.validateParams,
  taskReadyNotification: TaskReadyNotificationDefinition.validateParams,
  taskFailedNotification: TaskFailedNotificationDefinition.validateParams,
  taskClosedNotification: TaskClosedNotificationDefinition.validateParams,
  taskAdmissionCompleteNotification:
    TaskAdmissionCompleteNotificationDefinition.validateParams,
} as const;

export type ValidatorName = keyof typeof validators;
