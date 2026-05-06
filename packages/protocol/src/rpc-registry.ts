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
  TasksCreate,
  TasksGet,
  TasksList,
  TasksClose,
  TasksCreateConversation,
  TasksCloseConversation,
  TasksAddParticipant,
  TasksRemoveParticipant,
  TasksStoreMessage,
  TasksGetMessages,
  TasksGetMessagesSince,
} from "./task/methods/tasks.js";
import {
  AppsAuthorizeDispatch,
  TaskAuthorizeDispatch,
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
  TasksCreate,
  TasksGet,
  TasksList,
  TasksClose,
  TasksCreateConversation,
  TasksCloseConversation,
  TasksAddParticipant,
  TasksRemoveParticipant,
  TasksStoreMessage,
  TasksGetMessages,
  TasksGetMessagesSince,
] as const;

export const appRpcMethods = [AppsAuthorizeDispatch] as const;

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

/**
 * Server-initiated awaitable RPCs the WS client must handle. Phase 9b
 * consumer-migration (sub-issue #460): the legacy `appCallbackRpcMethods`
 * group retired with the deletion of `apps/onBeforeMessageDelivery`,
 * `apps/onSessionActive`, `apps/onClose` and the rename of
 * `apps/onBeforeDispatch` → `task/authorizeDispatch` (plan §2.4).
 *
 * `taskCallbackRpcMethods` is the surviving server→client awaitable
 * surface. Single member today (the receive-side TM admission round-trip);
 * post-Phase-11 arena migration the group may grow with additional
 * task-layer awaitable verbs.
 */
export const taskCallbackRpcMethods = [
  TaskAuthorizeDispatch,
] as const satisfies ReadonlyArray<RpcDefinition<string, any, any>>;

export const taskCallbackRpcGroup = defineRpcGroup(
  "taskCallback",
  taskCallbackRpcMethods,
);

export type TaskCallbackRpcMethodName =
  (typeof taskCallbackRpcMethods)[number]["name"];

export type AnyTaskCallbackRpcDefinition =
  (typeof taskCallbackRpcMethods)[number];

export type TaskCallbackRpcDefinitionFor<
  Name extends TaskCallbackRpcMethodName,
> = RpcDefinitionForName<typeof taskCallbackRpcMethods, Name>;

export type TaskCallbackRpcParams<Name extends TaskCallbackRpcMethodName> =
  ParamsOf<TaskCallbackRpcDefinitionFor<Name>>;
export type TaskCallbackRpcResult<Name extends TaskCallbackRpcMethodName> =
  ResultOf<TaskCallbackRpcDefinitionFor<Name>>;
