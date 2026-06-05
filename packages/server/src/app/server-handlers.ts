/**
 * @file The server RPC handler map.
 *
 * One entry per WS-dispatched method, keyed by its wire tag, valued by the
 * method's handler body (a `*.handlers.ts` export). Each handler is
 * `(payload, { clientId, headers }) => Effect`: requirement middleware has
 * already run, so the body reads the narrowed principal and domain services.
 *
 * Protocol binds this map onto the server engine. `agents/register` is
 * HTTP-only — served over `http-routes.ts`, never a catalog member, so it has
 * no entry here.
 *
 * The handler-map/catalog correlation is checked when `MoltZapServer` accepts
 * this object as its handler map.
 * Requirement middleware provides the per-method authority tags before the
 * handler body.
 */
import {
  connectAgent,
  connectApp,
} from "../identity/handlers/connect.handlers.js";
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
import { dispatchRequest, dispatchesGet } from "./handlers/apps.handlers.js";

/**
 * The handler map. Keys are the wire method names of every WS-dispatched
 * method; values are the per-method handler bodies.
 */
export const serverHandlers = {
  "agent/connect": connectAgent,
  "app/connect": connectApp,
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
  "dispatches/get": dispatchesGet,
} as const;
