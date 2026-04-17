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
      phone: Type.Optional(Type.String()),
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

export const ContactsDiscover = defineRpc({
  name: "contacts/discover",
  params: Type.Object(
    {
      phoneHashes: Type.Array(Type.String(), { maxItems: 1000 }),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      matches: Type.Array(
        Type.Object(
          {
            phoneHash: Type.String(),
            userId: Type.String({ format: "uuid" }),
            displayName: Type.String(),
          },
          { additionalProperties: false },
        ),
      ),
    },
    { additionalProperties: false },
  ),
});
