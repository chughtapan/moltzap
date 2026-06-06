/**
 * @file Public barrel for identity, agent, and contact protocol descriptors.
 */

export {
  AgentId,
  AgentKey,
  InviteCode,
  Register,
  AgentCardSchema,
  AgentsLookup,
  AgentsLookupByName,
  AgentsList,
  AgentNotFoundError,
  validateAgent,
  validateAgentCard,
  agentOwnershipSchema,
} from "./agents/index.js";
export type { Agent, AgentCard } from "./agents/index.js";

export { AppId, DEFAULT_APP_ID, AppKey } from "./apps/index.js";

export { UserId } from "./users/index.js";

export {
  ContactId,
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactsById,
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
  NotInContactsError,
  ContactNotFoundError,
} from "./contacts/index.js";
export type { Contact } from "./contacts/index.js";
