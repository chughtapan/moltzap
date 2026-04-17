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
import { PushRegister, PushUnregister } from "./schema/methods/push.js";
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
import {
  SurfaceUpdate,
  SurfaceGet,
  SurfaceAction,
  SurfaceClear,
} from "./schema/surfaces.js";
import type { RpcDefinition } from "./rpc.js";

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
  // Push
  PushRegister,
  PushUnregister,
  // Apps
  AppsCreate,
  AppsAttestSkill,
  PermissionsGrant,
  PermissionsList,
  PermissionsRevoke,
  AppsCloseSession,
  AppsGetSession,
  AppsListSessions,
  // Surfaces
  SurfaceUpdate,
  SurfaceGet,
  SurfaceAction,
  SurfaceClear,
] as const;

/**
 * Projection of `rpcMethods` by wire name. For any method `M = RpcMap[Name]`:
 *   - `M.params` is the params type
 *   - `M.result` is the result type
 *   - `M.definition` is the full `RpcDefinition` (useful for introspection)
 */
export type RpcMap = {
  [M in (typeof rpcMethods)[number] as M["name"]]: {
    params: M["Params"];
    result: M["Result"];
    definition: M;
  };
};

/**
 * A method name is any key of `RpcMap`. Contract-drift check: if you add a
 * method to `rpcMethods`, this union expands automatically. If you rename
 * the wire `name` field, every call site typed against `RpcMethodName`
 * fails at compile time.
 */
export type RpcMethodName = keyof RpcMap;

/** Helper for callers that want the manifest type for a given name. */
export type RpcDefinitionFor<Name extends RpcMethodName> =
  RpcMap[Name]["definition"];

/**
 * The `rpcMethods` tuple typed as a general array of RpcDefinitions — useful
 * for iteration helpers that don't care about preserving literal names.
 */
export type AnyRpcDefinition = (typeof rpcMethods)[number] &
  RpcDefinition<
    string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    any
  >;
