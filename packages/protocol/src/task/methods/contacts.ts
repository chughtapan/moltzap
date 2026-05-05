import { Type } from "@sinclair/typebox";
import { ContactId, UserId } from "../../schema/primitives.js";
import { ContactSchema } from "../../schema/contacts.js";
import { defineRpc } from "../../rpc.js";

export const ContactsList = defineRpc({
  name: "contacts/list",
  params: Type.Object({}, { additionalProperties: false }),
  result: Type.Object(
    {
      contacts: Type.Array(ContactSchema),
    },
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
    {
      contact: ContactSchema,
    },
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
