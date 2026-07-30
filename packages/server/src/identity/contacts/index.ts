/** @file Contact identity server internals. */

/** Re-exports the public API from `./handlers.js`. */
export { contactsAccept, contactsAdd, contactsList } from "./handlers.js";
/** Re-exports the public API from `./contact-policy.js`. */
export type { ContactService } from "./contact-policy.js";
/** Re-exports the public API from `./contact.service.js`. */
export { ContactsService } from "./contact.service.js";
/** Re-exports the public API from `./layer.js`. */
export { ContactsServiceTag } from "./layer.js";
/** Re-exports the public API from `./webhook-contact-service.js`. */
export { WebhookContactService } from "./webhook-contact-service.js";
