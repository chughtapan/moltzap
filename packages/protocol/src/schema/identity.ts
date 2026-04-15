import { Type, type Static } from "@sinclair/typebox";
import { stringEnum, DateTimeString } from "../helpers.js";
import { AgentId, UserId } from "./primitives.js";

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

export type Agent = Static<typeof AgentSchema>;
export type AgentCard = Static<typeof AgentCardSchema>;
