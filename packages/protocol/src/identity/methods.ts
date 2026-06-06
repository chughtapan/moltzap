import { AgentsLookup, AgentsLookupByName, AgentsList } from "./agents/index.js";
import {
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactsById,
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
} from "./contacts/index.js";

// `agents/register` (`Register` in `agents.ts`) is HTTP-only: served over
// `http-routes.ts`, never dispatched on the WS engine, so it is NOT a catalog
// member. Its `paramsSchema` is still the HTTP body schema.
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
