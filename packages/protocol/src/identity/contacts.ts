import { Data, Schema } from "effect";
import { brandedId, listCursorSchema } from "../schema-primitives.js";
import { ListLimitSchema } from "../pagination.js";
import { defineRpc, defineNotification } from "../transport/method.js";
import {
  registerErrorClass,
  type RpcErrorPayload,
} from "../transport/wire-errors.js";
import { UserId } from "./agents.js";

export const ContactId = brandedId("ContactId");
export type ContactId = Schema.Schema.Type<typeof ContactId>;

export class NotInContactsError extends Data.TaggedError(
  "NotInContacts",
)<RpcErrorPayload> {
  static readonly code = -32005;
  static readonly message = "Recipient blocks unsolicited contacts";
}
registerErrorClass(NotInContactsError);

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

/**
 * List contacts for the authenticated agent.
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
  callablePrincipal: "agent",
});

/**
 * Create a contact request.
 */
export const ContactsAdd = defineRpc({
  name: "contacts/add",
  params: Schema.Struct({
    contactUserId: UserId,
    relationship: Schema.optional(Schema.String),
  }),
  result: Schema.Struct({ contact: ContactSchema }),
  callablePrincipal: "agent",
});

/**
 * Accept a pending contact request.
 */
export const ContactsAccept = defineRpc({
  name: "contacts/accept",
  params: Schema.Struct({ contactId: ContactId }),
  result: Schema.Struct({ contact: ContactSchema }),
  callablePrincipal: "agent",
});

/**
 * Look up a contact by its identifier.
 */
export const ContactsById = defineRpc({
  name: "contacts/byId",
  params: Schema.Struct({ contactId: ContactId }),
  result: Schema.Struct({ contact: ContactSchema }),
  callablePrincipal: "agent",
});

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
