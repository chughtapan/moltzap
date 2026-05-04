import Ajv from "ajv";
import addFormats from "ajv-formats";
import { type Static, type TSchema } from "@sinclair/typebox";
import {
  RequestFrameSchema,
  ResponseFrameSchema,
  NotificationFrameSchema,
  type RequestFrame,
  type ResponseFrame,
  type NotificationFrame,
} from "./schema/index.js";
import { PushPreferencesSchema } from "./schema/methods/push.js";
import {
  Register,
  InviteAgent,
  Connect,
  SelectAgent,
  AgentsLookup,
  AgentsLookupByName,
  AgentsList,
} from "./schema/methods/auth.js";
import { MessagesSend, MessagesList } from "./schema/methods/messages.js";
import {
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactId_,
} from "./schema/methods/contacts.js";
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
} from "./schema/methods/conversations.js";
import { InvitesCreateAgent } from "./schema/methods/invites.js";
import {
  PresenceUpdate,
  PresenceSubscribe,
} from "./schema/methods/presence.js";
import {
  AppHookTimeoutNotificationDefinition,
  AppParticipantAdmittedNotificationDefinition,
  AppParticipantRejectedNotificationDefinition,
  AppSessionClosedNotificationDefinition,
  AppSessionFailedNotificationDefinition,
  AppSessionReadyNotificationDefinition,
  AppSkillChallengeNotificationDefinition,
  ContactAcceptedNotificationDefinition,
  ContactRequestNotificationDefinition,
  ConversationArchivedNotificationDefinition,
  ConversationCreatedNotificationDefinition,
  ConversationUnarchivedNotificationDefinition,
  ConversationUpdatedNotificationDefinition,
  MessageDeliveredNotificationDefinition,
  MessageReceivedNotificationDefinition,
  PermissionsRequiredNotificationDefinition,
  PresenceChangedNotificationDefinition,
  SurfaceClearedNotificationDefinition,
  SurfaceUpdatedNotificationDefinition,
} from "./schema/notifications.js";
import { PushRegister, PushUnregister } from "./schema/methods/push.js";
import {
  SurfaceUpdate,
  SurfaceGet,
  SurfaceAction,
  SurfaceClear,
} from "./schema/surfaces.js";
import {
  AppsRegister,
  AppsCreate,
  AppsAttestSkill,
  PermissionsGrant,
  PermissionsList,
  PermissionsRevoke,
  AppsCloseSession,
  AppsGetSession,
  AppsListSessions,
  AppsAuthorizeDispatch,
  AppsAttachConversation,
} from "./schema/methods/apps.js";
import { SystemPing } from "./schema/methods/system.js";

/**
 * This AJV instance handles frame-level validation only. Each RPC
 * manifest carries its own pre-compiled `validateParams` (compiled once
 * inside `defineRpc`), which is what the router dispatches against.
 */
const ajv = addFormats(new Ajv({ strict: true, allErrors: true }));

const compileGuard = <S extends TSchema, Guarded = Static<S>>(schema: S) => {
  const validate = ajv.compile<Static<S>>(schema);
  return (value: unknown): value is Guarded => validate(value);
};

/**
 * Named validator table. Every RPC manifest's `validateParams` is re-exported
 * here under a stable `xxxParams` key. Frame validators and notification
 * payload validators live here because they are not request/response RPCs.
 */
export const validators = {
  // Frames.
  requestFrame: compileGuard<typeof RequestFrameSchema, RequestFrame>(
    RequestFrameSchema,
  ),
  responseFrame: compileGuard<typeof ResponseFrameSchema, ResponseFrame>(
    ResponseFrameSchema,
  ),
  notificationFrame: compileGuard<
    typeof NotificationFrameSchema,
    NotificationFrame
  >(NotificationFrameSchema),

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
  contactIdParams: ContactId_.validateParams,

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

  // Push.
  pushRegisterParams: PushRegister.validateParams,
  pushUnregisterParams: PushUnregister.validateParams,
  pushPreferencesParams: compileGuard(PushPreferencesSchema),

  // Surfaces.
  surfaceUpdateParams: SurfaceUpdate.validateParams,
  surfaceGetParams: SurfaceGet.validateParams,
  surfaceActionParams: SurfaceAction.validateParams,
  surfaceClearParams: SurfaceClear.validateParams,

  // Apps.
  appsRegisterParams: AppsRegister.validateParams,
  appsCreateParams: AppsCreate.validateParams,
  appsAttestSkillParams: AppsAttestSkill.validateParams,
  permissionsGrantParams: PermissionsGrant.validateParams,
  permissionsListParams: PermissionsList.validateParams,
  permissionsRevokeParams: PermissionsRevoke.validateParams,
  appsCloseSessionParams: AppsCloseSession.validateParams,
  appsGetSessionParams: AppsGetSession.validateParams,
  appsListSessionsParams: AppsListSessions.validateParams,
  appsAuthorizeDispatchParams: AppsAuthorizeDispatch.validateParams,
  appsAttachConversationParams: AppsAttachConversation.validateParams,

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
  surfaceUpdatedNotification:
    SurfaceUpdatedNotificationDefinition.validateParams,
  surfaceClearedNotification:
    SurfaceClearedNotificationDefinition.validateParams,
  appSkillChallengeNotification:
    AppSkillChallengeNotificationDefinition.validateParams,
  permissionsRequiredNotification:
    PermissionsRequiredNotificationDefinition.validateParams,
  appParticipantAdmittedNotification:
    AppParticipantAdmittedNotificationDefinition.validateParams,
  appParticipantRejectedNotification:
    AppParticipantRejectedNotificationDefinition.validateParams,
  appSessionReadyNotification:
    AppSessionReadyNotificationDefinition.validateParams,
  appSessionFailedNotification:
    AppSessionFailedNotificationDefinition.validateParams,
  appSessionClosedNotification:
    AppSessionClosedNotificationDefinition.validateParams,
  appHookTimeoutNotification:
    AppHookTimeoutNotificationDefinition.validateParams,
} as const;

export type ValidatorName = keyof typeof validators;
