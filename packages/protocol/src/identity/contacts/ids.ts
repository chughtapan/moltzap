import { Schema, type Brand } from "effect";

import { formatString } from "../../transport/wire-string.js";

export type ContactId = string & Brand.Brand<"ContactId">;
export const ContactId: Schema.Schema<ContactId, string> = formatString(
  "uuid",
).pipe(
  Schema.brand("ContactId"),
  Schema.annotations({ description: "Branded ContactId" }),
);
