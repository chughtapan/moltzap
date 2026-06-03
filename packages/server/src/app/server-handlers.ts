/**
 * @file The `@effect/rpc` handler map for {@link ServerEngineRpcGroup}.
 *
 * One entry per WS-dispatched method, keyed by its wire tag, valued by the
 * method's handler body (a `*.handlers.ts` export). Each handler is
 * `(payload, { clientId, headers }) => Effect`: it reads its `*Auth` proof
 * for the narrowed principal + cap proofs, provides the caps as services, and
 * runs its handler body.
 *
 * `ServerEngineRpcGroup.toLayer(serverHandlers)` binds this map onto the
 * engine. `agents/register` + `agents/claim` are HTTP-only — served over
 * `http-routes.ts`, never catalog members, so they have no entry here.
 *
 * The handler-map↔group correlation is pinned by `server-handlers.types-check.ts`:
 * the map's keys exactly equal the engine group's member tags, and each handler's
 * residual requirement excludes its `*Auth` proof (the middleware provides it).
 */
import { connect } from "../identity/handlers/connect.handlers.js";
import {
  agentsLookup,
  agentsLookupByName,
  agentsList,
} from "../identity/handlers/agents-lookup.handlers.js";
import {
  contactsList,
  contactsAdd,
  contactsAccept,
  contactsById,
} from "../identity/handlers/contacts.handlers.js";
import { presenceSubscribe } from "../network/handlers/presence.handlers.js";
import {
  messagesSend,
  messagesList,
} from "../task/handlers/messages.handlers.js";
import {
  taskList,
  taskLeave,
  taskClose,
  taskAddParticipant,
  taskRemoveParticipant,
  taskConversationCreate,
  taskConversationList,
  taskConversationArchive,
  taskConversationUnarchive,
  taskConversationAddParticipant,
  taskConversationRemoveParticipant,
} from "../task/handlers/tasks.handlers.js";
import { taskRequest } from "./handlers/task-request.handlers.js";
import {
  appsRegister,
  dispatchRequest,
  dispatchesGet,
} from "./handlers/apps.handlers.js";

/**
 * The handler map. Keys are the wire method names of every WS-dispatched method
 * (the {@link ServerEngineRpcGroup} member tags); values are the per-method
 * handler bodies. The canary pins that the key set exactly equals the engine's
 * WS-handled tag set.
 */
export const serverHandlers = {
  "network/connect": connect,
  "agents/lookup": agentsLookup,
  "agents/lookupByName": agentsLookupByName,
  "agents/list": agentsList,
  "contacts/list": contactsList,
  "contacts/add": contactsAdd,
  "contacts/accept": contactsAccept,
  "contacts/byId": contactsById,
  "presence/subscribe": presenceSubscribe,
  "messages/send": messagesSend,
  "messages/list": messagesList,
  "task/list": taskList,
  "task/leave": taskLeave,
  "task/request": taskRequest,
  "task/close": taskClose,
  "task/addParticipant": taskAddParticipant,
  "task/removeParticipant": taskRemoveParticipant,
  "task/conversation/create": taskConversationCreate,
  "task/conversation/list": taskConversationList,
  "task/conversation/archive": taskConversationArchive,
  "task/conversation/unarchive": taskConversationUnarchive,
  "task/conversation/participants/add": taskConversationAddParticipant,
  "task/conversation/participants/remove": taskConversationRemoveParticipant,
  "dispatch/request": dispatchRequest,
  "apps/register": appsRegister,
  "dispatches/get": dispatchesGet,
} as const;
