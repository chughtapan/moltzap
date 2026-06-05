export {
  AgentNotFoundError,
  UserId,
  AgentId,
  validateAgent,
  validateAgentCard,
  agentOwnershipSchema,
  Register,
  AgentsLookup,
  AgentsLookupByName,
  AgentsList,
} from "./agents.js";
export type { Agent, AgentCard } from "./agents.js";

export {
  ContactId,
  NotInContactsError,
  ContactNotFoundError,
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactsById,
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
} from "./contacts.js";
export type { Contact } from "./contacts.js";

import { AgentsLookup, AgentsLookupByName, AgentsList } from "./agents.js";
import {
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactsById,
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
} from "./contacts.js";

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
