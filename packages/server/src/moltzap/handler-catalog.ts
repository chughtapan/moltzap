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
import { connectAgent } from "#network";
import { agentsList } from "#identity/agents";
import { messagesSend, messagesList } from "#message/handlers";
import {
  agentConversationCreate,
  conversationList,
} from "#conversation/handlers";
import type { ServerHandlers } from "@moltzap/protocol/socket/catalog";

/**
 * The handler map. Keys are the wire method names of every WS-dispatched
 * method; values are the per-method handler bodies.
 */
export const serverHandlers: ServerHandlers = {
  "agent/network/connect": connectAgent,
  "agent/identity/agents/list": agentsList,
  "agent/message/send": messagesSend,
  "agent/message/list": messagesList,
  "agent/conversation/list": conversationList,
  "agent/conversation/create": agentConversationCreate,
} as const;
