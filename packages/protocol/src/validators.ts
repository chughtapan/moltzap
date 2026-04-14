import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  RequestFrameSchema,
  ResponseFrameSchema,
  EventFrameSchema,
  RegisterParamsSchema,
  InviteAgentParamsSchema,
  ConnectParamsSchema,
  SelectAgentParamsSchema,
  AgentsLookupParamsSchema,
  AgentsLookupByNameParamsSchema,
  AgentsListParamsSchema,
  UsersLookupParamsSchema,
  UsersUpdateProfileParamsSchema,
  MessagesSendParamsSchema,
  MessagesListParamsSchema,
  MessagesReactParamsSchema,
  MessagesDeleteParamsSchema,
  ContactsListParamsSchema,
  ContactsAddParamsSchema,
  ContactsAcceptParamsSchema,
  ContactIdParamsSchema,
  ContactsDiscoverParamsSchema,
  ContactsSyncParamsSchema,
  ConversationsCreateParamsSchema,
  ConversationsListParamsSchema,
  ConversationsGetParamsSchema,
  ConversationsUpdateParamsSchema,
  ConversationsMuteParamsSchema,
  ConversationsAddParticipantParamsSchema,
  ConversationsRemoveParticipantParamsSchema,
  ConversationsLeaveParamsSchema,
  ConversationsUnmuteParamsSchema,
  InvitesCreateAgentParamsSchema,
  PresenceUpdateParamsSchema,
  PresenceSubscribeParamsSchema,
  PushRegisterParamsSchema,
  PushUnregisterParamsSchema,
  SurfaceUpdateParamsSchema,
  SurfaceGetParamsSchema,
  SurfaceActionParamsSchema,
  SurfaceClearParamsSchema,
  PushPreferencesSchema,
} from "./schema/index.js";

const ajv = addFormats(new Ajv({ strict: true, allErrors: true }));

export const validators = {
  requestFrame: ajv.compile(RequestFrameSchema),
  responseFrame: ajv.compile(ResponseFrameSchema),
  eventFrame: ajv.compile(EventFrameSchema),

  // Auth
  registerParams: ajv.compile(RegisterParamsSchema),
  inviteAgentParams: ajv.compile(InviteAgentParamsSchema),
  connectParams: ajv.compile(ConnectParamsSchema),
  selectAgentParams: ajv.compile(SelectAgentParamsSchema),
  agentsLookupParams: ajv.compile(AgentsLookupParamsSchema),
  agentsLookupByNameParams: ajv.compile(AgentsLookupByNameParamsSchema),
  agentsListParams: ajv.compile(AgentsListParamsSchema),
  usersLookupParams: ajv.compile(UsersLookupParamsSchema),
  usersUpdateProfileParams: ajv.compile(UsersUpdateProfileParamsSchema),
  // Messages
  messagesSendParams: ajv.compile(MessagesSendParamsSchema),
  messagesListParams: ajv.compile(MessagesListParamsSchema),
  messagesReactParams: ajv.compile(MessagesReactParamsSchema),
  messagesDeleteParams: ajv.compile(MessagesDeleteParamsSchema),

  // Contacts
  contactsListParams: ajv.compile(ContactsListParamsSchema),
  contactsAddParams: ajv.compile(ContactsAddParamsSchema),
  contactsAcceptParams: ajv.compile(ContactsAcceptParamsSchema),
  contactIdParams: ajv.compile(ContactIdParamsSchema),
  contactsDiscoverParams: ajv.compile(ContactsDiscoverParamsSchema),
  contactsSyncParams: ajv.compile(ContactsSyncParamsSchema),

  // Conversations
  conversationsCreateParams: ajv.compile(ConversationsCreateParamsSchema),
  conversationsListParams: ajv.compile(ConversationsListParamsSchema),
  conversationsGetParams: ajv.compile(ConversationsGetParamsSchema),
  conversationsUpdateParams: ajv.compile(ConversationsUpdateParamsSchema),
  conversationsMuteParams: ajv.compile(ConversationsMuteParamsSchema),
  conversationsAddParticipantParams: ajv.compile(
    ConversationsAddParticipantParamsSchema,
  ),
  conversationsRemoveParticipantParams: ajv.compile(
    ConversationsRemoveParticipantParamsSchema,
  ),
  conversationsLeaveParams: ajv.compile(ConversationsLeaveParamsSchema),
  conversationsUnmuteParams: ajv.compile(ConversationsUnmuteParamsSchema),

  // Invites
  invitesCreateAgentParams: ajv.compile(InvitesCreateAgentParamsSchema),

  // Presence
  presenceUpdateParams: ajv.compile(PresenceUpdateParamsSchema),
  presenceSubscribeParams: ajv.compile(PresenceSubscribeParamsSchema),
  // Push
  pushRegisterParams: ajv.compile(PushRegisterParamsSchema),
  pushUnregisterParams: ajv.compile(PushUnregisterParamsSchema),

  // Surfaces
  surfaceUpdateParams: ajv.compile(SurfaceUpdateParamsSchema),
  surfaceGetParams: ajv.compile(SurfaceGetParamsSchema),
  surfaceActionParams: ajv.compile(SurfaceActionParamsSchema),
  surfaceClearParams: ajv.compile(SurfaceClearParamsSchema),
  pushPreferencesParams: ajv.compile(PushPreferencesSchema),
} as const;

export type ValidatorName = keyof typeof validators;
