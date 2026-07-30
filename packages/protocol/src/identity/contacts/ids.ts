import { Schema, type Brand } from "effect";

import { formatString } from "#transport";

/** Represents contact id values. */
export type ContactId = string & Brand.Brand<"ContactId">;
/** Validates and decodes contact id values. */
export const contactId: Schema.Schema<ContactId, string> = formatString(
  "uuid",
).pipe(
  Schema.brand("ContactId"),
  Schema.annotations({ description: "Branded ContactId" }),
);
