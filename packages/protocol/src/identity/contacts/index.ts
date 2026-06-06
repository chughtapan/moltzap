/**
 * @file Contact identity descriptors, RPC descriptors, and notifications.
 */
export { ContactId } from "./ids.js";
export {
  ContactsList,
  ContactsAdd,
  ContactsAccept,
  ContactsById,
  ContactRequestNotificationDefinition,
  ContactAcceptedNotificationDefinition,
  NotInContactsError,
  ContactNotFoundError,
} from "./protocol.js";
