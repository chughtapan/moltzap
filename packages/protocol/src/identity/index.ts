// AgentId is exported as VALUE here (not type-only) so that
// testing/conformance/<layer>/ tests reaching identity methods through
// the workspace-name path can use it as a TypeBox schema constant
// (`registerTestAgent({ id: AgentId(...) })` style).
export {
  AgentId,
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

export type { ContactId, UserId, AgentCard, Contact } from "./methods.js";
