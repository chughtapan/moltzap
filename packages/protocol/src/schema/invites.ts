import { Type, type Static } from "@sinclair/typebox";
import { stringEnum, DateTimeString } from "../helpers.js";
import { UserId, ConversationId } from "./primitives.js";

export const InviteTypeEnum = stringEnum(["contact", "group"]);
export const InviteStatusEnum = stringEnum(["pending", "accepted", "expired"]);

export const InviteSchema = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    inviterId: UserId,
    token: Type.String({ minLength: 43 }),
    type: InviteTypeEnum,
    targetPhone: Type.Optional(Type.String()),
    conversationId: Type.Optional(ConversationId),
    status: InviteStatusEnum,
    createdAt: DateTimeString,
    expiresAt: DateTimeString,
  },
  { additionalProperties: false },
);

export type Invite = Static<typeof InviteSchema>;
