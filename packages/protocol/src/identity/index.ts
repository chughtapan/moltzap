/**
 * @file Public barrel for identity, agent, contact, and invite protocol descriptors.
 */
export type { AgentId, ContactId, UserId } from "./methods.js";

export {
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
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
  NotInContactsError,
} from "./methods.js";

export type { AgentCard, Contact } from "./methods.js";
