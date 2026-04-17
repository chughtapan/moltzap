import { Type, type Static } from "@sinclair/typebox";
import { AgentId } from "../primitives.js";
import { ConversationSummarySchema } from "../conversations.js";
import { AgentCardSchema } from "../identity.js";
import { defineRpc } from "../../rpc.js";

export const OwnedAgentSchema = AgentCardSchema;

/** Shared sub-schemas used by auth results (exported for docs). */
export const RateLimitsSchema = Type.Object(
  {
    messagesPerMinute: Type.Integer(),
    requestsPerMinute: Type.Integer(),
  },
  { additionalProperties: false },
);

export const PolicySchema = Type.Object(
  {
    maxMessageBytes: Type.Integer(),
    maxPartsPerMessage: Type.Integer(),
    maxTextLength: Type.Integer(),
    maxGroupParticipants: Type.Integer(),
    heartbeatIntervalMs: Type.Integer(),
    rateLimits: RateLimitsSchema,
  },
  { additionalProperties: false },
);

export const HelloOkSchema = Type.Object(
  {
    protocolVersion: Type.String(),
    agentId: AgentId,
    conversations: Type.Array(ConversationSummarySchema),
    unreadCounts: Type.Record(Type.String(), Type.Integer()),
    policy: PolicySchema,
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// RpcDefinition manifests — one per wire method.
// ---------------------------------------------------------------------------

export const Connect = defineRpc({
  name: "auth/connect",
  params: Type.Object(
    {
      agentKey: Type.String(),
      minProtocol: Type.String(),
      maxProtocol: Type.String(),
    },
    { additionalProperties: false },
  ),
  result: HelloOkSchema,
});

export const Register = defineRpc({
  name: "auth/register",
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

export const InviteAgent = defineRpc({
  name: "auth/invite-agent",
  params: Type.Object(
    {
      phone: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  // invite-agent's result shape hasn't been formalized yet. Use an open
  // object so we don't lock in a shape we haven't designed.
  result: Type.Object({}, { additionalProperties: true }),
});

export const SelectAgent = defineRpc({
  name: "auth/selectAgent",
  params: Type.Object(
    {
      agentId: AgentId,
    },
    { additionalProperties: false },
  ),
  // selectAgent returns no structured result today — kept open for flexibility.
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
    {
      agents: Type.Array(AgentCardSchema),
    },
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
    {
      agents: Type.Array(AgentCardSchema),
    },
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

// Auth types that aren't RPC params/results — these are shared schemas
// surfaced as standalone types for downstream use.
export type HelloOk = Static<typeof HelloOkSchema>;
export type OwnedAgent = Static<typeof OwnedAgentSchema>;
