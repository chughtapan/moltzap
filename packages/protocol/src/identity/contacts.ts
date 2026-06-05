import { Schema } from "effect";
import { brandedId } from "../transport/wire-string.js";
import { ListLimitSchema, listCursorSchema } from "../transport/pagination.js";
import { defineRpc, defineNotification } from "../transport/method.js";
import { AgentPrincipal } from "../transport/principal.js";
import {
  ConflictError,
  ForbiddenError,
  InvalidParamsError,
  UnauthorizedError,
} from "../transport/wire-errors.js";
import { UserId } from "./agents.js";

// ═══════════════════════════════════════════════════════════════════
// SHARED — contact value types + errors used by 2+ blocks in this file.
//
// `ContactSchema` is the contact-row shape returned by every method and pushed
// by both notifications. `NotInContactsError` (exported; the presence /
// messaging surface raises it too) is the contact-reach error channel;
// `ContactNotFoundError` is the per-resource not-found; the cross-cutting
// `ForbiddenError` / `ConflictError` ride the per-method `errors` unions.
// ═══════════════════════════════════════════════════════════════════

/** Optional supplemental wire fields every domain tagged-error carries. */
const errorPayloadFields = {
  message: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
} as const;

export const ContactId = brandedId("ContactId");
export type ContactId = Schema.Schema.Type<typeof ContactId>;

export class NotInContactsError extends Schema.TaggedError<NotInContactsError>()(
  "NotInContacts",
  errorPayloadFields,
) {
  static readonly message = "Recipient blocks unsolicited contacts";
}

/** The referenced contact does not exist (or is not the caller's). */
export class ContactNotFoundError extends Schema.TaggedError<ContactNotFoundError>()(
  "ContactNotFound",
  errorPayloadFields,
) {
  static readonly message = "Contact not found";
}

const RelationshipType = Schema.String;

const ContactSchema = Schema.Struct({
  id: ContactId,
  contactUserId: UserId,
  relationship: Schema.optional(RelationshipType),
  metadata: Schema.optional(
    Schema.Struct({
      tags: Schema.optional(
        Schema.Array(
          Schema.Record({ key: Schema.String, value: Schema.String }),
        ),
      ),
    }),
  ),
});

export type Contact = Schema.Schema.Type<typeof ContactSchema>;

// ═══════════════════════════════════════════════════════════════════
// contacts/list
// ═══════════════════════════════════════════════════════════════════

/**
 * List contacts for the authenticated agent.
 *
 * - **Principal:** `AgentPrincipal` head (no claimed refinement).
 * @error InvalidParamsError when the `cursor` does not decode
 * @error UnauthorizedError when the calling agent has no owner user
 */
export const ContactsList = defineRpc({
  name: "contacts/list",
  params: Schema.Struct({
    limit: ListLimitSchema,
    cursor: Schema.optional(listCursorSchema()),
  }),
  result: Schema.Struct({
    contacts: Schema.Array(ContactSchema),
    nextCursor: Schema.optional(listCursorSchema()),
  }),
  requires: [AgentPrincipal],
  errors: [InvalidParamsError, UnauthorizedError],
});

// ═══════════════════════════════════════════════════════════════════
// contacts/add
// ═══════════════════════════════════════════════════════════════════

/**
 * Create a contact request.
 *
 * - **Principal:** `AgentPrincipal` head (no claimed refinement).
 * @error ForbiddenError when the caller tries to add itself as a contact
 * @error ConflictError when the contact already exists
 * @error UnauthorizedError when the calling agent has no owner user
 */
export const ContactsAdd = defineRpc({
  name: "contacts/add",
  params: Schema.Struct({
    contactUserId: UserId,
    relationship: Schema.optional(Schema.String),
  }),
  result: Schema.Struct({ contact: ContactSchema }),
  requires: [AgentPrincipal],
  errors: [ForbiddenError, ConflictError, UnauthorizedError],
});

// ═══════════════════════════════════════════════════════════════════
// contacts/accept
// ═══════════════════════════════════════════════════════════════════

/**
 * Accept a pending contact request.
 *
 * - **Principal:** `AgentPrincipal` head (no claimed refinement).
 * @error ContactNotFoundError when the referenced contact does not exist
 * @error ForbiddenError when the caller is not the request recipient
 * @error UnauthorizedError when the calling agent has no owner user
 */
export const ContactsAccept = defineRpc({
  name: "contacts/accept",
  params: Schema.Struct({ contactId: ContactId }),
  result: Schema.Struct({ contact: ContactSchema }),
  requires: [AgentPrincipal],
  errors: [ContactNotFoundError, ForbiddenError, UnauthorizedError],
});

// ═══════════════════════════════════════════════════════════════════
// contacts/byId
// ═══════════════════════════════════════════════════════════════════

/**
 * Look up a contact by its identifier.
 *
 * - **Principal:** `AgentPrincipal` head (no claimed refinement).
 * @error ContactNotFoundError when the referenced contact does not exist
 * @error UnauthorizedError when the calling agent has no owner user
 */
export const ContactsById = defineRpc({
  name: "contacts/byId",
  params: Schema.Struct({ contactId: ContactId }),
  result: Schema.Struct({ contact: ContactSchema }),
  requires: [AgentPrincipal],
  errors: [ContactNotFoundError, UnauthorizedError],
});

// ═══════════════════════════════════════════════════════════════════
// contact/request + contact/accepted (notifications)
// ═══════════════════════════════════════════════════════════════════

const ContactRequestNotificationSchema = Schema.Struct({
  contact: ContactSchema,
});

const ContactAcceptedNotificationSchema = Schema.Struct({
  contact: ContactSchema,
});

/**
 * Pushed when an agent receives a contact request.
 */
export const ContactRequestNotificationDefinition = defineNotification({
  name: "contact/request",
  params: ContactRequestNotificationSchema,
});

/**
 * Pushed when a contact request is accepted.
 */
export const ContactAcceptedNotificationDefinition = defineNotification({
  name: "contact/accepted",
  params: ContactAcceptedNotificationSchema,
});
