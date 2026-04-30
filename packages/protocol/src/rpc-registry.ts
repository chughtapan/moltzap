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
  AppsAuthorizeDispatch,
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
  AppsAuthorizeDispatch,
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
  RpcDefinition<string, any, any>;

/**
 * Server-initiated RPC manifests (server → client). Parallel to `rpcMethods`
 * for c2s. Direction-namespaced so c2s dispatch (server router) cannot
 * collide with s2c dispatch (client handler registry).
 *
 * The tuple is intentionally empty in Phase 1.0 — the primitives ship before
 * any verbs do. Phase 1.1 (B.2) populates it with the admission/lifecycle
 * verbs (`apps/onBeforeDispatch`, `apps/onBeforeMessageDelivery`,
 * `apps/onSessionActive`, `apps/onJoin`, `apps/onClose`).
 *
 * Shape parity with `rpcMethods` is load-bearing: once verbs land, callers
 * type against `S2cRpcMethodName` and `S2cRpcMap[M]`, and the `as const`
 * preserves literal names for the projection.
 */
export const s2cRpcMethods = [] as const satisfies ReadonlyArray<
  RpcDefinition<string, any, any>
>;

/**
 * Projection of `s2cRpcMethods` by wire name. Empty until Phase 1.1 verbs
 * register. The shape mirrors `RpcMap`.
 */
export type S2cRpcMap = {
  [M in (typeof s2cRpcMethods)[number] as M["name"]]: {
    params: M["Params"];
    result: M["Result"];
    definition: M;
  };
};

/**
 * `S2cRpcMethodName = never` until verbs land in `s2cRpcMethods`. Once
 * populated, every `sendRpcToClient` / `handleServerRpc` call site narrows
 * against this union.
 */
export type S2cRpcMethodName = keyof S2cRpcMap;

/** Helper for callers that want the manifest type for a given s2c method. */
export type S2cRpcDefinitionFor<Name extends S2cRpcMethodName> =
  S2cRpcMap[Name]["definition"];
