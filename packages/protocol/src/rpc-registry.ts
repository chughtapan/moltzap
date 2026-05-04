import {
  Connect,
  Register,
  InviteAgent,
  SelectAgent,
  AgentsLookup,
  AgentsLookupByName,
  AgentsList,
} from "./schema/methods/auth.js";
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
} from "./schema/methods/conversations.js";
import { MessagesSend, MessagesList } from "./schema/methods/messages.js";
import {
  ContactsList,
  ContactsAdd,
  ContactsAccept,
} from "./schema/methods/contacts.js";
import { InvitesCreateAgent } from "./schema/methods/invites.js";
import {
  PresenceUpdate,
  PresenceSubscribe,
} from "./schema/methods/presence.js";
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
} from "./schema/methods/apps.js";
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

/**
 * Every RPC manifest the protocol defines, as a literal tuple. Order doesn't
 * matter — the wire name is the dispatch key. The `as const` is load-bearing:
 * it preserves literal types so `RpcMap` can project every manifest by its
 * `name` into a keyed type.
 */
export const rpcMethods = [
  // Auth
  Connect,
  Register,
  InviteAgent,
  SelectAgent,
  AgentsLookup,
  AgentsLookupByName,
  AgentsList,
  // Conversations
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
  // Messages
  MessagesSend,
  MessagesList,
  // Contacts
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  // Invites
  InvitesCreateAgent,
  // Presence
  PresenceUpdate,
  PresenceSubscribe,
  // Apps
  AppsCreate,
  AppsCloseSession,
  AppsGetSession,
  AppsListSessions,
  AppsAuthorizeDispatch,
  AppsAttachConversation,
] as const;

export const taskRpcGroup = defineRpcGroup("task", rpcMethods);

/**
 * Branded union of every client → server method name. The only public method
 * values should come from descriptors (`MessagesSend.name`), not raw strings.
 */
export type RpcMethodName = (typeof rpcMethods)[number]["name"];

/** Helper for callers that want the manifest type for a given name. */
export type RpcDefinitionFor<Name extends RpcMethodName> = RpcDefinitionForName<
  typeof rpcMethods,
  Name
>;

/** Extract params/result types from a branded RPC method name. */
export type RpcParams<Name extends RpcMethodName> = ParamsOf<
  RpcDefinitionFor<Name>
>;
export type RpcResult<Name extends RpcMethodName> = ResultOf<
  RpcDefinitionFor<Name>
>;

/**
 * The `rpcMethods` tuple typed as a general array of RpcDefinitions — useful
 * for iteration helpers that don't care about preserving literal names.
 */
export type AnyRpcDefinition = (typeof rpcMethods)[number] &
  RpcDefinition<string, any, any>;

/**
 * App-callback RPC manifests. These are normal JSON-RPC requests whose
 * handlers live in the connected app client; the wire frame carries no
 * direction marker.
 *
 * Shape parity with `rpcMethods` is load-bearing: callers type against
 * `AppCallbackRpcMethodName`, and the `as const` preserves literal names for
 * the projection. All entries are AWAITABLE; void-result verbs still reply
 * (with `{}`) so the caller's `Deferred.await` can fire.
 */
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

/**
 * Branded union of every app-callback method name.
 */
export type AppCallbackRpcMethodName =
  (typeof appCallbackRpcMethods)[number]["name"];

/**
 * The app-callback tuple typed as general RpcDefinitions for descriptor-backed
 * APIs that dispatch by descriptor object and only extract `.name` at the wire
 * encoder/decoder edge.
 */
export type AnyAppCallbackRpcDefinition =
  (typeof appCallbackRpcMethods)[number];

/** Helper for callers that want the manifest type for an app-callback method. */
export type AppCallbackRpcDefinitionFor<Name extends AppCallbackRpcMethodName> =
  RpcDefinitionForName<typeof appCallbackRpcMethods, Name>;

/** Extract params/result types from a branded app-callback RPC name. */
export type AppCallbackRpcParams<Name extends AppCallbackRpcMethodName> =
  ParamsOf<AppCallbackRpcDefinitionFor<Name>>;
export type AppCallbackRpcResult<Name extends AppCallbackRpcMethodName> =
  ResultOf<AppCallbackRpcDefinitionFor<Name>>;
