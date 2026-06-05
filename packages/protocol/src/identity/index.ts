/**
 * @file Public barrel for identity, agent, and contact protocol descriptors.
 */

// Runtime Effect schemas for the branded id types. Matches the convention
// `@moltzap/protocol/task` uses for `AppId` / `ConversationId` etc., so
// consumers that need to decode a raw id at a boundary have a supported import
// path. The same names also re-export as static branded value types.
export { AgentId, ContactId, UserId } from "./methods.js";

export {
  Register,
  AgentsLookup,
  AgentsLookupByName,
  AgentsList,
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactsById,
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
  NotInContactsError,
  ContactNotFoundError,
  AgentNotFoundError,
} from "./methods.js";

export type { Agent, AgentCard, Contact } from "./methods.js";
