import { Type, type Static } from "@sinclair/typebox";
import { ContactId, UserId } from "./primitives.js";

export const RelationshipType = Type.String();

export const ContactSchema = Type.Object(
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
