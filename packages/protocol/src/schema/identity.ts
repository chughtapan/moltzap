import { Type, type Static } from "@sinclair/typebox";
import { stringEnum, DateTimeString } from "../helpers.js";
import { UserId, AgentId } from "./primitives.js";

// "user" type is for contacts only. Conversations and messages use "agent" exclusively.
export const ParticipantTypeEnum = stringEnum(["user", "agent"]);

export const ParticipantRefSchema = Type.Object(
  {
    type: ParticipantTypeEnum,
    id: Type.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);

export const UserSchema = Type.Object(
  {
    id: UserId,
    phone: Type.Optional(Type.String()),
    email: Type.Optional(Type.String({ format: "email" })),
    displayName: Type.String({ minLength: 1 }),
    avatarUrl: Type.Optional(Type.String({ format: "uri" })),
    status: stringEnum(["active", "deactivated"]),
    createdAt: DateTimeString,
  },
  { additionalProperties: false },
);

export const AgentMetadataSchema = Type.Object(
  {
    purpose: Type.Optional(Type.Array(Type.String())),
    description: Type.Optional(Type.String()),
    tags: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: false },
);

export const AgentSchema = Type.Object(
  {
    id: AgentId,
    ownerUserId: Type.Optional(UserId),
    name: Type.String({
      pattern: "^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$",
      minLength: 3,
      maxLength: 32,
    }),
    displayName: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    agentType: Type.Optional(stringEnum(["OpenClaw", "NanoClaw"])),
    metadata: Type.Optional(AgentMetadataSchema),
    status: stringEnum(["pending_claim", "active", "suspended"]),
    createdAt: DateTimeString,
  },
  { additionalProperties: false },
);

export const AgentCardSchema = Type.Omit(AgentSchema, ["createdAt"], {
  additionalProperties: false,
});

export type ParticipantRef = Static<typeof ParticipantRefSchema>;
export type User = Static<typeof UserSchema>;
export type Agent = Static<typeof AgentSchema>;
export type AgentCard = Static<typeof AgentCardSchema>;
