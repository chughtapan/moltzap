/**
 * @file Contact identity descriptors, RPC descriptors, and notifications.
 */
export { ContactId } from "./ids.js";
export {
  ContactAcceptedNotificationDefinition,
  ContactNotFoundError,
  ContactRequestNotificationDefinition,
  ContactsAccept,
  ContactsAdd,
  ContactsList,
  NotInContactsError,
} from "./contacts.js";
export { ContactPolicyAllowsReach } from "./requirements/index.js";
export type { ContactPolicyAllowsReachValue } from "./requirements/index.js";
