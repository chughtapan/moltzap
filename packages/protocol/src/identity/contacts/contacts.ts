import { Schema } from "effect";

import { defineRpc, defineNotification } from "../../transport/method.js";
import {
  ListLimitSchema,
  listCursorSchema,
} from "../../transport/pagination.js";
import { AgentPrincipal } from "#identity/principals";
import {
  ConflictError,
  ForbiddenError,
  InvalidParamsError,
  UnauthorizedError,
} from "../../transport/wire-errors.js";
import { UserId } from "../users/index.js";
import { ContactId } from "./ids.js";

const errorPayloadFields = {
  message: Schema.optional(Schema.String),
  data: Schema.optional(Schema.Unknown),
} as const;

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

export const ContactsAccept = defineRpc({
  name: "contacts/accept",
  params: Schema.Struct({ contactId: ContactId }),
  result: Schema.Struct({ contact: ContactSchema }),
  requires: [AgentPrincipal],
  errors: [ContactNotFoundError, ForbiddenError, UnauthorizedError],
});

export const ContactsById = defineRpc({
  name: "contacts/byId",
  params: Schema.Struct({ contactId: ContactId }),
  result: Schema.Struct({ contact: ContactSchema }),
  requires: [AgentPrincipal],
  errors: [ContactNotFoundError, UnauthorizedError],
});

const ContactRequestNotificationSchema = Schema.Struct({
  contact: ContactSchema,
});

const ContactAcceptedNotificationSchema = Schema.Struct({
  contact: ContactSchema,
});

export const ContactRequestNotificationDefinition = defineNotification({
  name: "contact/request",
  params: ContactRequestNotificationSchema,
});

export const ContactAcceptedNotificationDefinition = defineNotification({
  name: "contact/accepted",
  params: ContactAcceptedNotificationSchema,
});
