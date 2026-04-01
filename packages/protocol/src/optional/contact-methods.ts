// Contact-specific RPC method schemas — optional subpath export
// Import via "@moltzap/protocol/contact-methods" or from the main entry (backward compat)
export {
  ContactsListParamsSchema,
  ContactsListResultSchema,
  ContactsAddParamsSchema,
  ContactsAddResultSchema,
  ContactsAcceptParamsSchema,
  ContactsAcceptResultSchema,
  ContactIdParamsSchema,
  ContactsDiscoverParamsSchema,
  ContactsDiscoverResultSchema,
  EmptyResultSchema,
} from "../schema/methods/contacts.js";

export type {
  ContactsListParams,
  ContactsListResult,
  ContactsAddParams,
  ContactsAddResult,
  ContactsAcceptParams,
  ContactsAcceptResult,
  ContactIdParams,
  ContactsDiscoverParams,
  ContactsDiscoverResult,
} from "../schema/methods/contacts.js";

export {
  ContactsSyncParamsSchema,
  ContactsSyncResultSchema,
} from "../schema/methods/phone-contacts.js";

export type {
  ContactsSyncParams,
  ContactsSyncResult,
} from "../schema/methods/phone-contacts.js";
