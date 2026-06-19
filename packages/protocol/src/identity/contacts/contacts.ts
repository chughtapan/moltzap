import { Schema } from "effect";

import { defineRpc, defineNotification } from "#transport/descriptor";
import {
  ListLimitSchema,
  listCursorSchema,
  errorPayloadFields,
} from "#transport";
import { AgentPrincipal } from "#identity/principals";
import {
  ConflictError,
  ForbiddenError,
  InvalidParamsError,
  UnauthorizedError,
} from "#transport";
import { UserId } from "#identity/users";
import { ContactId } from "./ids.js";

export class NotInContactsError extends Schema.TaggedError<NotInContactsError>()(
  "NotInContacts",
  errorPayloadFields,
) {
  static readonly message = "Recipient blocks unsolicited contacts";
}

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

export const ContactsList = defineRpc({
  name: "agent/identity/contacts/list",
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

export const ContactsAdd = defineRpc({
  name: "agent/identity/contacts/add",
  params: Schema.Struct({
    contactUserId: UserId,
    relationship: Schema.optional(Schema.String),
  }),
  result: Schema.Struct({ contact: ContactSchema }),
  requires: [AgentPrincipal],
  errors: [ForbiddenError, ConflictError, UnauthorizedError],
});

export const ContactsAccept = defineRpc({
  name: "agent/identity/contacts/accept",
  params: Schema.Struct({ contactId: ContactId }),
  result: Schema.Struct({ contact: ContactSchema }),
  requires: [AgentPrincipal],
  errors: [ContactNotFoundError, ForbiddenError, UnauthorizedError],
});

const ContactRequestNotificationSchema = Schema.Struct({
  contact: ContactSchema,
});

const ContactAcceptedNotificationSchema = Schema.Struct({
  contact: ContactSchema,
});

export const ContactRequestNotificationDefinition = defineNotification({
  name: "agent/identity/contact-requested",
  params: ContactRequestNotificationSchema,
});

export const ContactAcceptedNotificationDefinition = defineNotification({
  name: "agent/identity/contact-accepted",
  params: ContactAcceptedNotificationSchema,
});
