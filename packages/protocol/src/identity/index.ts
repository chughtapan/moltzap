/**
 * @file Public barrel for identity, agent, and contact protocol descriptors.
 */

// Runtime TypeBox schemas for the branded id types. Matches the
// convention `@moltzap/protocol/task` uses for `AppId` /
// `ConversationId` etc., so consumers that need to call
// `Value.Decode(AgentId, raw)` to attach the brand at runtime have a
// supported import path. The same names also re-export as types
// below for callers that only need the static `BrandedString` view.
export { AgentId, ContactId, UserId } from "./methods.js";

export {
  Register,
  Claim,
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
} from "./methods.js";

export type { Agent, AgentCard, Contact } from "./methods.js";
