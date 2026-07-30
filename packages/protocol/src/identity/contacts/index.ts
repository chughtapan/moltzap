/**
 * @file Contact identity descriptors, RPC descriptors, and notifications.
 */
export { type ContactId, contactId } from "./ids.js";
/** Re-exports the public API from `./contacts.js`. */
export {
  contactsList,
  contactsAdd,
  contactsAccept,
  contactRequestNotificationDefinition,
  contactAcceptedNotificationDefinition,
  NotInContactsError,
  ContactNotFoundError,
} from "./contacts.js";
/** Re-exports the public API from `./requirements/index.js`. */
export { ContactPolicyAllowsReach } from "./requirements/index.js";
/** Re-exports the public API from `./requirements/index.js`. */
export type { ContactPolicyAllowsReachValue } from "./requirements/index.js";
