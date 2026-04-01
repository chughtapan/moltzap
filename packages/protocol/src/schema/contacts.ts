import { Type, type Static } from "@sinclair/typebox";
import { stringEnum, DateTimeString } from "../helpers.js";
import { ContactId, UserId } from "./primitives.js";

export const ContactStatusEnum = stringEnum(["pending", "accepted", "blocked"]);

export const ContactSchema = Type.Object(
  {
    id: ContactId,
    requesterId: UserId,
    targetId: UserId,
    status: ContactStatusEnum,
    createdAt: DateTimeString,
    requesterName: Type.Optional(Type.String()),
    requesterPhone: Type.Optional(Type.String()),
    targetName: Type.Optional(Type.String()),
    targetPhone: Type.Optional(Type.String()),
    agents: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: Type.String(),
            name: Type.String(),
          },
          { additionalProperties: false },
        ),
      ),
    ),
    lastSeenAt: Type.Optional(Type.String({ format: "date-time" })),
  },
  { additionalProperties: false },
);

export type Contact = Static<typeof ContactSchema>;
