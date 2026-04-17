import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  RequestFrameSchema,
  ResponseFrameSchema,
  EventFrameSchema,
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
  ContactsDiscover,
} from "./schema/methods/contacts.js";
import { ContactsSync } from "./schema/methods/phone-contacts.js";
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
} from "./schema/methods/conversations.js";
import { InvitesCreateAgent } from "./schema/methods/invites.js";
import {
  PresenceUpdate,
  PresenceSubscribe,
} from "./schema/methods/presence.js";
import { PushRegister, PushUnregister } from "./schema/methods/push.js";
import {
  SurfaceUpdate,
  SurfaceGet,
  SurfaceAction,
  SurfaceClear,
} from "./schema/surfaces.js";
import {
  AppsCreate,
  AppsAttestSkill,
  PermissionsGrant,
  PermissionsList,
  PermissionsRevoke,
  AppsCloseSession,
  AppsGetSession,
  AppsListSessions,
} from "./schema/methods/apps.js";

/**
 * This AJV instance handles frame-level validation only. Each RPC
 * manifest carries its own pre-compiled `validateParams` (compiled once
 * inside `defineRpc`), which is what the router dispatches against.
 */
const ajv = addFormats(new Ajv({ strict: true, allErrors: true }));

/**
 * Named validator table. Every RPC manifest's `validateParams` is re-exported
 * here under the legacy `xxxParams` key so existing call sites keep working.
 * Frame validators (`requestFrame`, `responseFrame`, `eventFrame`) live here
 * because they're not RPC methods.
 */
export const validators = {
  // Frames.
  requestFrame: ajv.compile(RequestFrameSchema),
  responseFrame: ajv.compile(ResponseFrameSchema),
  eventFrame: ajv.compile(EventFrameSchema),

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
  contactsDiscoverParams: ContactsDiscover.validateParams,
  contactsSyncParams: ContactsSync.validateParams,

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

  // Invites.
  invitesCreateAgentParams: InvitesCreateAgent.validateParams,

  // Presence.
  presenceUpdateParams: PresenceUpdate.validateParams,
  presenceSubscribeParams: PresenceSubscribe.validateParams,

  // Push.
  pushRegisterParams: PushRegister.validateParams,
  pushUnregisterParams: PushUnregister.validateParams,
  pushPreferencesParams: ajv.compile(PushPreferencesSchema),

  // Surfaces.
  surfaceUpdateParams: SurfaceUpdate.validateParams,
  surfaceGetParams: SurfaceGet.validateParams,
  surfaceActionParams: SurfaceAction.validateParams,
  surfaceClearParams: SurfaceClear.validateParams,

  // Apps.
  appsCreateParams: AppsCreate.validateParams,
  appsAttestSkillParams: AppsAttestSkill.validateParams,
  permissionsGrantParams: PermissionsGrant.validateParams,
  permissionsListParams: PermissionsList.validateParams,
  permissionsRevokeParams: PermissionsRevoke.validateParams,
  appsCloseSessionParams: AppsCloseSession.validateParams,
  appsGetSessionParams: AppsGetSession.validateParams,
  appsListSessionsParams: AppsListSessions.validateParams,
} as const;

export type ValidatorName = keyof typeof validators;
