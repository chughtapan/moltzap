import { Type } from "@sinclair/typebox";
import { ContactSchema } from "../contacts.js";
import { defineRpc } from "../../rpc.js";

export const ContactsSync = defineRpc({
  name: "contacts/sync",
  params: Type.Object(
    {
      phoneHashes: Type.Array(Type.String(), { maxItems: 1000 }),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      newMatches: Type.Array(ContactSchema),
      removed: Type.Array(Type.String()),
    },
    { additionalProperties: false },
  ),
});
