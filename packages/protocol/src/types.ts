export type {
  ParticipantRef,
  User,
  Agent,
  AgentCard,
} from "./schema/identity.js";
export type { Contact } from "./schema/contacts.js";
export type {
  Conversation,
  ConversationParticipant,
  ConversationSummary,
} from "./schema/conversations.js";
export type {
  TextPart,
  ImagePart,
  FilePart,
  Part,
  Message,
} from "./schema/messages.js";
export type { Invite } from "./schema/invites.js";
export type { PresenceEntry } from "./schema/presence.js";
export type { DeliveryEntry } from "./schema/delivery.js";
export type {
  RequestFrame,
  ResponseFrame,
  EventFrame,
} from "./schema/frames.js";
export type { RpcError, ErrorCode } from "./schema/errors.js";

// Auth method types
export type {
  ConnectParams,
  SelectAgentParams,
  RegisterParams,
  RegisterResult,
  InviteAgentParams,
  HelloOk,
  OwnedAgent,
  AgentsLookupParams,
  AgentsLookupResult,
  AgentsLookupByNameParams,
  AgentsLookupByNameResult,
  AgentsListParams,
  AgentsListResult,
  UsersLookupParams,
  UsersLookupResult,
  UsersUpdateProfileParams,
  UsersUpdateProfileResult,
} from "./schema/methods/auth.js";

// Messages method types
export type {
  MessagesSendParams,
  MessagesSendResult,
  MessagesListParams,
  MessagesListResult,
  MessagesReactParams,
  MessagesDeleteParams,
} from "./schema/methods/messages.js";

// Contacts method types
export type {
  ContactsListParams,
  ContactsListResult,
  ContactsAddParams,
  ContactsAddResult,
  ContactsAcceptParams,
  ContactsAcceptResult,
  ContactIdParams,
  ContactsDiscoverParams,
  ContactsDiscoverResult,
} from "./schema/methods/contacts.js";

// Phone contacts method types
export type {
  ContactsSyncParams,
  ContactsSyncResult,
} from "./schema/methods/phone-contacts.js";

// Conversations method types
export type {
  ConversationsCreateParams,
  ConversationsCreateResult,
  ConversationsListParams,
  ConversationsListResult,
  ConversationsGetParams,
  ConversationsGetResult,
  ConversationsUpdateParams,
  ConversationsMuteParams,
  ConversationsAddParticipantParams,
  ConversationsRemoveParticipantParams,
  ConversationsLeaveParams,
  ConversationsUnmuteParams,
} from "./schema/methods/conversations.js";

// Invites method types
export type { InvitesCreateAgentParams } from "./schema/methods/invites.js";

// Presence method types
export type {
  PresenceUpdateParams,
  PresenceSubscribeParams,
  PresenceSubscribeResult,
} from "./schema/methods/presence.js";

// Push method types
export type {
  PushRegisterParams,
  PushUnregisterParams,
  PushPreferences,
} from "./schema/methods/push.js";

// Surface types
export type {
  SurfaceUpdateParams,
  SurfaceGetParams,
  SurfaceActionParams,
  SurfaceClearParams,
  Surface,
} from "./schema/surfaces.js";
