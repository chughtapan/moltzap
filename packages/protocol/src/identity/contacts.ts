/* eslint-disable @typescript-eslint/no-magic-numbers --
   per-class wire error codes (replaces the central WIRE_CODES table). */
import { Data } from "effect";
import { Type, type Static } from "@sinclair/typebox";
import { brandedId } from "../schema-primitives.js";
import { defineRpc, defineNotification } from "../transport/method.js";
import {
  registerErrorClass,
  type RpcErrorPayload,
} from "../transport/wire-errors.js";
import { UserId } from "./agents.js";

export const ContactId = brandedId("ContactId");
export type ContactId = Static<typeof ContactId>;

export class NotInContactsError extends Data.TaggedError(
  "NotInContacts",
)<RpcErrorPayload> {
  static readonly code = -32005;
  static readonly message = "Recipient blocks unsolicited contacts";
}
registerErrorClass(NotInContactsError);

const RelationshipType = Type.String();

const ContactSchema = Type.Object(
  {
    id: ContactId,
    contactUserId: UserId,
    relationship: Type.Optional(RelationshipType),
    metadata: Type.Optional(
      Type.Object(
        {
          tags: Type.Optional(
            Type.Array(Type.Record(Type.String(), Type.String())),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type Contact = Static<typeof ContactSchema>;

export const ContactsList = defineRpc({
  name: "contacts/list",
  params: Type.Object({}, { additionalProperties: false }),
  result: Type.Object(
    { contacts: Type.Array(ContactSchema) },
    { additionalProperties: false },
  ),
});

export const ContactsAdd = defineRpc({
  name: "contacts/add",
  params: Type.Object(
    {
      contactUserId: UserId,
      relationship: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { contact: ContactSchema },
    { additionalProperties: false },
  ),
});

export const ContactsAccept = defineRpc({
  name: "contacts/accept",
  params: Type.Object(
    { contactId: ContactId },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { contact: ContactSchema },
    { additionalProperties: false },
  ),
});

export const ContactsById = defineRpc({
  name: "contacts/byId",
  params: Type.Object(
    { contactId: ContactId },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { contact: ContactSchema },
    { additionalProperties: false },
  ),
});

const ContactRequestNotificationSchema = Type.Object(
  { contact: ContactSchema },
  { additionalProperties: false },
);

const ContactAcceptedNotificationSchema = Type.Object(
  { contact: ContactSchema },
  { additionalProperties: false },
);

export const ContactRequestNotificationDefinition = defineNotification({
  name: "contact/request",
  params: ContactRequestNotificationSchema,
});

export const ContactAcceptedNotificationDefinition = defineNotification({
  name: "contact/accepted",
  params: ContactAcceptedNotificationSchema,
});
