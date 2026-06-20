/** @file Contact identity server internals. */

export { contactsAccept, contactsAdd, contactsList } from "./handlers.js";
export type { ContactService } from "./contact-policy.js";
export { ContactsService } from "./contact.service.js";
export { ContactsServiceLive, ContactsServiceTag } from "./layer.js";
export { WebhookContactService } from "./webhook-contact-service.js";
