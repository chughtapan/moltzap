import { Type, type Static } from "@sinclair/typebox";
import { ContactId, UserId } from "../primitives.js";
import { ContactSchema, ContactSourceEnum } from "../contacts.js";
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
      contactUserId: Type.Optional(UserId),
      source: Type.Optional(ContactSourceEnum),
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

/**
 * Shared params schema for any contact-by-id operation (decline, remove, etc.).
 * Kept as a `defineRpc` for symmetry, but the name is a generic umbrella —
 * callers using this should pass a more-specific manifest for dispatch.
 */
export const ContactId_ = defineRpc({
  name: "contacts/byId",
  params: Type.Object(
    { contactId: ContactId },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});
