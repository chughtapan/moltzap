/**
 * @file The server-side MoltZap RPC handler map.
 *
 * One entry per WS-dispatched method, keyed by its wire tag, valued by the
 * method's handler body (a `*.handlers.ts` export). Each handler is
 * `(payload, { clientId, headers }) => Effect`: requirement middleware has
 * already run, so the body reads the narrowed principal and domain services.
 *
 * Protocol binds this map onto the server engine. `agent/identity/register` is
 * HTTP-only — served over `http/routes.ts`, never a catalog member, so it has
 * no entry here.
 *
 * The handler-map/catalog correlation is checked when `MoltZapServer` accepts
 * this object as its handler map.
 * Requirement middleware provides the per-method authority tags before the
 * handler body.
 */
import { connectAgent, connectApp } from "#network";
import { agentsList } from "#identity/agents";
import { contactsAccept, contactsAdd, contactsList } from "#identity/contacts";
import {
  agentPresenceSubscribe,
  appPresenceSubscribe,
} from "#network/presence";
import { messagesSend, messagesList } from "#message/handlers";
import { taskList, taskLeave, taskRequest, taskUpdate } from "#task/handlers";
import {
  conversationCreate,
  conversationList,
  conversationUpdate,
} from "#conversation/handlers";
import { dispatchRequest, dispatchLeaseGet } from "#dispatch/handlers";
import type { ServerHandlers } from "@moltzap/protocol/socket/catalog";

/**
 * The handler map. Keys are the wire method names of every WS-dispatched
 * method; values are the per-method handler bodies.
 */
export const serverHandlers: ServerHandlers = {
  "agent/network/connect": connectAgent,
  "app/network/connect": connectApp,
  "agent/identity/agents/list": agentsList,
  "agent/identity/contacts/list": contactsList,
  "agent/identity/contacts/add": contactsAdd,
  "agent/identity/contacts/accept": contactsAccept,
  "agent/network/presence/subscribe": agentPresenceSubscribe,
  "app/network/presence/subscribe": appPresenceSubscribe,
  "agent/message/send": messagesSend,
  "agent/message/list": messagesList,
  "agent/task/list": taskList,
  "agent/task/leave": taskLeave,
  "agent/task/request": taskRequest,
  "app/task/update": taskUpdate,
  "app/conversation/create": conversationCreate,
  "agent/conversation/list": conversationList,
  "app/conversation/update": conversationUpdate,
  "agent/dispatch/request": dispatchRequest,
  "app/dispatch/lease/get": dispatchLeaseGet,
} as const;
