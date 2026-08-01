import { type Brand, Schema } from "effect";

import { formatString } from "#transport";

export type ContactId = string & Brand.Brand<"ContactId">;
export const ContactId: Schema.Schema<ContactId, string> = formatString(
  "uuid",
).pipe(
  Schema.brand("ContactId"),
  Schema.annotations({ description: "Branded ContactId" }),
);
