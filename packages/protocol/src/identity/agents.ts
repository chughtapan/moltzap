import { Type, type Static } from "@sinclair/typebox";
import { stringEnum, DateTimeString, brandedId } from "../schema-primitives.js";
import { defineRpc } from "../transport/method.js";

export const UserId = brandedId("UserId");
export type UserId = Static<typeof UserId>;
export const AgentId = brandedId("AgentId");
export type AgentId = Static<typeof AgentId>;

const AgentMetadataSchema = Type.Object(
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

export const AgentOwnershipSchema = Type.Object(
  {
    agentId: AgentId,
    ownerId: Type.String(),
  },
  { additionalProperties: false },
);

export type Agent = Static<typeof AgentSchema>;
export type AgentCard = Static<typeof AgentCardSchema>;

export const Register = defineRpc({
  name: "agents/register",
  params: Type.Object(
    {
      name: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$" }),
      description: Type.Optional(Type.String({ maxLength: 500 })),
      inviteCode: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      agentId: AgentId,
      apiKey: Type.String(),
      claimUrl: Type.String({ format: "uri" }),
      claimToken: Type.String(),
    },
    { additionalProperties: false },
  ),
});

/** Bind ownerUserId to a registered agent via claimToken. Idempotent on
 * (token, owner); rejects different owner. Same inviteCode gate as Register. */
export const Claim = defineRpc({
  name: "agents/claim",
  params: Type.Object(
    {
      claimToken: Type.String({ minLength: 1 }),
      ownerUserId: Type.String({ format: "uuid" }),
      inviteCode: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      agentId: AgentId,
      ownerUserId: Type.String({ format: "uuid" }),
    },
    { additionalProperties: false },
  ),
});

export const InviteAgent = defineRpc({
  name: "agents/invite",
  params: Type.Object(
    { phone: Type.Optional(Type.String()) },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: true }),
});

export const AgentsLookup = defineRpc({
  name: "agents/lookup",
  params: Type.Object(
    {
      agentIds: Type.Array(Type.String({ format: "uuid" }), {
        minItems: 1,
        maxItems: 100,
      }),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { agents: Type.Array(AgentCardSchema) },
    { additionalProperties: false },
  ),
});

export const AgentsLookupByName = defineRpc({
  name: "agents/lookupByName",
  params: Type.Object(
    {
      names: Type.Array(Type.String({ minLength: 1, maxLength: 32 }), {
        minItems: 1,
        maxItems: 100,
      }),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { agents: Type.Array(AgentCardSchema) },
    { additionalProperties: false },
  ),
});

export const AgentsList = defineRpc({
  name: "agents/list",
  params: Type.Object({}, { additionalProperties: false }),
  result: Type.Object(
    { agents: Type.Record(AgentId, AgentCardSchema) },
    { additionalProperties: false },
  ),
});
