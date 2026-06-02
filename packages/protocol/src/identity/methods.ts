export * from "./agents.js";
export * from "./contacts.js";

import { AgentsLookup, AgentsLookupByName, AgentsList } from "./agents.js";
import {
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactsById,
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
} from "./contacts.js";

// `agents/register` + `agents/claim` (`Register`/`Claim` in `agents.ts`) are
// HTTP-only: served over `http-routes.ts`, never dispatched on the WS engine, so
// they are NOT catalog members. Their `paramsSchema` is still the HTTP body
// schema (`http-routes.ts → httpBodyGuard(Register.paramsSchema)`).
export const identityRpcMethods = [
  AgentsLookup,
  AgentsLookupByName,
  AgentsList,
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactsById,
] as const;

export const identityNotifications = [
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
] as const;
