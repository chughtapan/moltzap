export * from "./agents.js";
export * from "./contacts.js";
export * from "./invites.js";

import {
  Register,
  Claim,
  InviteAgent,
  AgentsLookup,
  AgentsLookupByName,
  AgentsList,
} from "./agents.js";
import {
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactsById,
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
} from "./contacts.js";
import { InvitesCreateAgent } from "./invites.js";

export const identityRpcMethods = [
  Register,
  Claim,
  InviteAgent,
  AgentsLookup,
  AgentsLookupByName,
  AgentsList,
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactsById,
  InvitesCreateAgent,
] as const;

export const identityNotifications = [
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
] as const;
