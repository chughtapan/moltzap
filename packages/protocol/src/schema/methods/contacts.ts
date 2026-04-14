import { Type, type Static } from "@sinclair/typebox";
import { ContactId, UserId } from "../primitives.js";
import { ContactSchema, ContactSourceEnum } from "../contacts.js";

export const ContactsListParamsSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const ContactsListResultSchema = Type.Object(
  {
    contacts: Type.Array(ContactSchema),
  },
  { additionalProperties: false },
);

export const ContactsAddParamsSchema = Type.Object(
  {
    contactUserId: Type.Optional(UserId),
    phone: Type.Optional(Type.String()),
    source: Type.Optional(ContactSourceEnum),
    relationship: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const ContactsAddResultSchema = Type.Object(
  {
    contact: ContactSchema,
  },
  { additionalProperties: false },
);

export const ContactsAcceptParamsSchema = Type.Object(
  { contactId: ContactId },
  { additionalProperties: false },
);

export const ContactsAcceptResultSchema = Type.Object(
  { contact: ContactSchema },
  { additionalProperties: false },
);

export const ContactIdParamsSchema = Type.Object(
  { contactId: ContactId },
  { additionalProperties: false },
);

export const ContactsDiscoverParamsSchema = Type.Object(
  {
    phoneHashes: Type.Array(Type.String(), { maxItems: 1000 }),
  },
  { additionalProperties: false },
);

export const ContactsDiscoverResultSchema = Type.Object(
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
);

export const EmptyResultSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export type ContactsListParams = Static<typeof ContactsListParamsSchema>;
export type ContactsListResult = Static<typeof ContactsListResultSchema>;
export type ContactsAddParams = Static<typeof ContactsAddParamsSchema>;
export type ContactsAddResult = Static<typeof ContactsAddResultSchema>;
export type ContactsAcceptParams = Static<typeof ContactsAcceptParamsSchema>;
export type ContactsAcceptResult = Static<typeof ContactsAcceptResultSchema>;
export type ContactIdParams = Static<typeof ContactIdParamsSchema>;
export type ContactsDiscoverParams = Static<
  typeof ContactsDiscoverParamsSchema
>;
export type ContactsDiscoverResult = Static<
  typeof ContactsDiscoverResultSchema
>;
