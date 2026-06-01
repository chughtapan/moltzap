/**
 * @file The native `@effect/rpc` handler map for {@link ServerEngineRpcGroup}.
 *
 * One entry per WS-dispatched method, keyed by its wire tag, valued by the
 * method's native handler body (`*.handlers.ts` `native*` export). Each handler
 * is `(payload, { clientId, headers }) => Effect`: it reads its `*Auth` proof
 * for the narrowed principal + cap proofs, provides the caps as services, and
 * runs the same body the live `ErasedSlot` slot path runs.
 *
 * `ServerEngineRpcGroup.toLayer(serverNativeHandlers)` binds this map onto the
 * native engine. The HTTP-only catalog methods (`agents/register`,
 * `agents/claim`, `agents/invite`, `invites/createAgent`) have no WS handler;
 * they are served over `http-routes.ts` and are absent here.
 *
 * The handler-map↔group correlation is pinned by `native-handlers.types-check.ts`:
 * the map's keys exactly equal the engine group's member tags, and each handler's
 * residual requirement excludes its `*Auth` proof (the middleware provides it).
 */
import { nativeConnect } from "../identity/handlers/connect.handlers.js";
import {
  nativeAgentsLookup,
  nativeAgentsLookupByName,
  nativeAgentsList,
} from "../identity/handlers/agents-lookup.handlers.js";
import {
  nativeContactsList,
  nativeContactsAdd,
  nativeContactsAccept,
  nativeContactsById,
} from "../identity/handlers/contacts.handlers.js";
import { nativePing } from "../network/handlers/ping.handlers.js";
import { nativePresenceSubscribe } from "../network/handlers/presence.handlers.js";
import {
  nativeMessagesSend,
  nativeMessagesList,
} from "../task/handlers/messages.handlers.js";
import {
  nativeTaskList,
  nativeTaskLeave,
  nativeTaskClose,
  nativeTaskAddParticipant,
  nativeTaskRemoveParticipant,
  nativeTaskConversationCreate,
  nativeTaskConversationList,
  nativeTaskConversationArchive,
  nativeTaskConversationUnarchive,
  nativeTaskConversationAddParticipant,
  nativeTaskConversationRemoveParticipant,
} from "../task/handlers/tasks.handlers.js";
import { nativeTaskRequest } from "./handlers/task-request.handler.js";
import {
  nativeAppsRegister,
  nativeDispatchRequest,
  nativeDispatchesGet,
} from "./handlers/apps.handlers.js";

/**
 * The native handler map. Keys are the wire method names of every
 * WS-dispatched method (the {@link ServerEngineRpcGroup} member tags minus the
 * four HTTP-only methods); values are the per-method native handler bodies. The
 * canary pins that the key set exactly equals the engine's WS-handled tag set.
 */
export const serverNativeHandlers = {
  "network/connect": nativeConnect,
  "network/ping": nativePing,
  "agents/lookup": nativeAgentsLookup,
  "agents/lookupByName": nativeAgentsLookupByName,
  "agents/list": nativeAgentsList,
  "contacts/list": nativeContactsList,
  "contacts/add": nativeContactsAdd,
  "contacts/accept": nativeContactsAccept,
  "contacts/byId": nativeContactsById,
  "presence/subscribe": nativePresenceSubscribe,
  "messages/send": nativeMessagesSend,
  "messages/list": nativeMessagesList,
  "task/list": nativeTaskList,
  "task/leave": nativeTaskLeave,
  "task/request": nativeTaskRequest,
  "task/close": nativeTaskClose,
  "task/addParticipant": nativeTaskAddParticipant,
  "task/removeParticipant": nativeTaskRemoveParticipant,
  "task/conversation/create": nativeTaskConversationCreate,
  "task/conversation/list": nativeTaskConversationList,
  "task/conversation/archive": nativeTaskConversationArchive,
  "task/conversation/unarchive": nativeTaskConversationUnarchive,
  "task/conversation/participants/add": nativeTaskConversationAddParticipant,
  "task/conversation/participants/remove":
    nativeTaskConversationRemoveParticipant,
  "dispatch/request": nativeDispatchRequest,
  "apps/register": nativeAppsRegister,
  "dispatches/get": nativeDispatchesGet,
} as const;
