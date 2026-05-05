import {
  Connect,
  Register,
  InviteAgent,
  SelectAgent,
  AgentsLookup,
  AgentsLookupByName,
  AgentsList,
} from "./network/methods/auth.js";
import {
  ConversationsCreate,
  ConversationsList,
  ConversationsGet,
  ConversationsUpdate,
  ConversationsMute,
  ConversationsUnmute,
  ConversationsAddParticipant,
  ConversationsRemoveParticipant,
  ConversationsLeave,
  ConversationsArchive,
  ConversationsUnarchive,
} from "./task/methods/conversations.js";
import { MessagesSend, MessagesList } from "./task/methods/messages.js";
import {
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactsById,
} from "./task/methods/contacts.js";
import { InvitesCreateAgent } from "./task/methods/invites.js";
import { PresenceUpdate, PresenceSubscribe } from "./task/methods/presence.js";
import {
  AppsCreate,
  AppsCloseSession,
  AppsGetSession,
  AppsListSessions,
  AppsAuthorizeDispatch,
  AppsAttachConversation,
  AppsOnBeforeDispatch,
  AppsOnBeforeMessageDelivery,
  AppsOnSessionActive,
  AppsOnClose,
} from "./app/methods/apps.js";
import { SystemPing } from "./network/methods/system.js";
import type { RpcDefinition, ParamsOf, ResultOf } from "./rpc.js";
import type { JsonRpcMethod } from "./schema/json-rpc.js";
import { defineRpcGroup } from "./rpc-groups.js";

type RpcDefinitionForName<
  Methods extends ReadonlyArray<RpcDefinition<string, any, any>>,
  Name extends JsonRpcMethod,
> = Extract<
  Methods[number],
  RpcDefinition<
    Name extends JsonRpcMethod<infer RawName> ? RawName : never,
    any,
    any
  >
>;

export const networkRpcMethods = [
  Connect,
  Register,
  InviteAgent,
  SelectAgent,
  AgentsLookup,
  AgentsLookupByName,
  AgentsList,
  SystemPing,
] as const;

export const taskRpcMethods = [
  ConversationsCreate,
  ConversationsList,
  ConversationsGet,
  ConversationsUpdate,
  ConversationsMute,
  ConversationsUnmute,
  ConversationsAddParticipant,
  ConversationsRemoveParticipant,
  ConversationsLeave,
  ConversationsArchive,
  ConversationsUnarchive,
  MessagesSend,
  MessagesList,
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactsById,
  InvitesCreateAgent,
  PresenceUpdate,
  PresenceSubscribe,
] as const;

export const appRpcMethods = [
  AppsCreate,
  AppsCloseSession,
  AppsGetSession,
  AppsListSessions,
  AppsAuthorizeDispatch,
  AppsAttachConversation,
] as const;

export const rpcMethods = [
  ...networkRpcMethods,
  ...taskRpcMethods,
  ...appRpcMethods,
] as const;

export const networkRpcGroup = defineRpcGroup("network", networkRpcMethods);
export const taskRpcGroup = defineRpcGroup("task", taskRpcMethods);
export const appRpcGroup = defineRpcGroup("app", appRpcMethods);

export type RpcMethodName = (typeof rpcMethods)[number]["name"];

export type RpcDefinitionFor<Name extends RpcMethodName> = RpcDefinitionForName<
  typeof rpcMethods,
  Name
>;

export type RpcParams<Name extends RpcMethodName> = ParamsOf<
  RpcDefinitionFor<Name>
>;
export type RpcResult<Name extends RpcMethodName> = ResultOf<
  RpcDefinitionFor<Name>
>;

export type NetworkRpcMethodName = (typeof networkRpcMethods)[number]["name"];
export type TaskRpcMethodName = (typeof taskRpcMethods)[number]["name"];
export type AppRpcMethodName = (typeof appRpcMethods)[number]["name"];

export type AnyRpcDefinition = (typeof rpcMethods)[number] &
  RpcDefinition<string, any, any>;

export const appCallbackRpcMethods = [
  AppsOnBeforeDispatch,
  AppsOnBeforeMessageDelivery,
  AppsOnSessionActive,
  AppsOnClose,
] as const satisfies ReadonlyArray<RpcDefinition<string, any, any>>;

export const appCallbackRpcGroup = defineRpcGroup(
  "appCallback",
  appCallbackRpcMethods,
);

export type AppCallbackRpcMethodName =
  (typeof appCallbackRpcMethods)[number]["name"];

export type AnyAppCallbackRpcDefinition =
  (typeof appCallbackRpcMethods)[number];

export type AppCallbackRpcDefinitionFor<Name extends AppCallbackRpcMethodName> =
  RpcDefinitionForName<typeof appCallbackRpcMethods, Name>;

export type AppCallbackRpcParams<Name extends AppCallbackRpcMethodName> =
  ParamsOf<AppCallbackRpcDefinitionFor<Name>>;
export type AppCallbackRpcResult<Name extends AppCallbackRpcMethodName> =
  ResultOf<AppCallbackRpcDefinitionFor<Name>>;
