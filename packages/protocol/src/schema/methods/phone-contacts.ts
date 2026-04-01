import { Type, type Static } from "@sinclair/typebox";
import { ContactSchema } from "../contacts.js";

export const ContactsSyncParamsSchema = Type.Object(
  {
    phoneHashes: Type.Array(Type.String(), { maxItems: 1000 }),
  },
  { additionalProperties: false },
);

export const ContactsSyncResultSchema = Type.Object(
  {
    newMatches: Type.Array(ContactSchema),
    removed: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export type ContactsSyncParams = Static<typeof ContactsSyncParamsSchema>;
export type ContactsSyncResult = Static<typeof ContactsSyncResultSchema>;
