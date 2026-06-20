/**
 * @file Contact identity descriptors, RPC descriptors, and notifications.
 */
export { ContactId } from "./ids.js";
export {
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
  NotInContactsError,
  ContactNotFoundError,
} from "./contacts.js";
export { ContactPolicyAllowsReach } from "./requirements/index.js";
export type { ContactPolicyAllowsReachValue } from "./requirements/index.js";
