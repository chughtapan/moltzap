import { Schema } from "effect";

import { defineRpc, defineNotification } from "#transport/descriptor";
import {
  listLimitSchema,
  listCursorSchema,
  errorPayloadFields,
  ConflictError,
  ForbiddenError,
  InvalidParamsError,
  UnauthorizedError,
} from "#transport";
import { AgentPrincipal } from "#identity/principals";
import { userId } from "#identity/users";
import { contactId } from "./ids.js";

/** Reports not in contacts failures. */
export class NotInContactsError extends Schema.TaggedError<NotInContactsError>()(
  "NotInContacts",
  errorPayloadFields,
) {
  static readonly message = "Recipient blocks unsolicited contacts";
}

/** Reports contact not found failures. */
export class ContactNotFoundError extends Schema.TaggedError<ContactNotFoundError>()(
  "ContactNotFound",
  errorPayloadFields,
) {
  static readonly message = "Contact not found";
}

const relationshipType = Schema.String;

const contactSchema = Schema.Struct({
  id: contactId,
  contactUserId: userId,
  relationship: Schema.optional(relationshipType),
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

/** Defines the `agent/identity/contacts/list` RPC contract. */
export const contactsList = defineRpc({
  name: "agent/identity/contacts/list",
  params: Schema.Struct({
    limit: listLimitSchema,
    cursor: Schema.optional(listCursorSchema()),
  }),
  result: Schema.Struct({
    contacts: Schema.Array(contactSchema),
    nextCursor: Schema.optional(listCursorSchema()),
  }),
  requires: [AgentPrincipal],
  errors: [InvalidParamsError, UnauthorizedError],
});

/** Defines the `agent/identity/contacts/add` RPC contract. */
export const contactsAdd = defineRpc({
  name: "agent/identity/contacts/add",
  params: Schema.Struct({
    contactUserId: userId,
    relationship: Schema.optional(relationshipType),
  }),
  result: Schema.Struct({ contact: contactSchema }),
  requires: [AgentPrincipal],
  errors: [ForbiddenError, ConflictError, UnauthorizedError],
});

/** Defines the `agent/identity/contacts/accept` RPC contract. */
export const contactsAccept = defineRpc({
  name: "agent/identity/contacts/accept",
  params: Schema.Struct({ contactId: contactId }),
  result: Schema.Struct({ contact: contactSchema }),
  requires: [AgentPrincipal],
  errors: [ContactNotFoundError, ForbiddenError, UnauthorizedError],
});

/** Defines the `agent/identity/contact-requested` notification contract. */
export const contactRequestNotificationDefinition = defineNotification({
  name: "agent/identity/contact-requested",
  params: Schema.Struct({ contact: contactSchema }),
});

/** Defines the `agent/identity/contact-accepted` notification contract. */
export const contactAcceptedNotificationDefinition = defineNotification({
  name: "agent/identity/contact-accepted",
  params: Schema.Struct({ contact: contactSchema }),
});
