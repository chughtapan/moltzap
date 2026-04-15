import { Type, type Static } from "@sinclair/typebox";
import { AgentId } from "../primitives.js";
import { ConversationSummarySchema } from "../conversations.js";
import { AgentCardSchema } from "../identity.js";

export const OwnedAgentSchema = AgentCardSchema;

export const SelectAgentParamsSchema = Type.Object(
  {
    agentId: AgentId,
  },
  { additionalProperties: false },
);

export const RegisterParamsSchema = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$" }),
    description: Type.Optional(Type.String({ maxLength: 500 })),
    inviteCode: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

export const InviteAgentParamsSchema = Type.Object(
  {
    phone: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const RegisterResultSchema = Type.Object(
  {
    agentId: AgentId,
    apiKey: Type.String(),
    claimUrl: Type.String({ format: "uri" }),
    claimToken: Type.String(),
  },
  { additionalProperties: false },
);

export const ConnectParamsSchema = Type.Object(
  {
    agentKey: Type.String(),
    minProtocol: Type.String(),
    maxProtocol: Type.String(),
  },
  { additionalProperties: false },
);

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

export const AgentsLookupParamsSchema = Type.Object(
  {
    agentIds: Type.Array(Type.String({ format: "uuid" }), {
      minItems: 1,
      maxItems: 100,
    }),
  },
  { additionalProperties: false },
);

export const AgentsLookupResultSchema = Type.Object(
  {
    agents: Type.Array(AgentCardSchema),
  },
  { additionalProperties: false },
);

export const AgentsLookupByNameParamsSchema = Type.Object(
  {
    names: Type.Array(Type.String({ minLength: 1, maxLength: 32 }), {
      minItems: 1,
      maxItems: 100,
    }),
  },
  { additionalProperties: false },
);

export const AgentsLookupByNameResultSchema = Type.Object(
  {
    agents: Type.Array(AgentCardSchema),
  },
  { additionalProperties: false },
);

export const AgentsListParamsSchema = Type.Object(
  {},
  { additionalProperties: false },
);
export const AgentsListResultSchema = Type.Object(
  { agents: Type.Record(AgentId, AgentCardSchema) },
  { additionalProperties: false },
);

export type ConnectParams = Static<typeof ConnectParamsSchema>;
export type SelectAgentParams = Static<typeof SelectAgentParamsSchema>;
export type RegisterParams = Static<typeof RegisterParamsSchema>;
export type RegisterResult = Static<typeof RegisterResultSchema>;
export type InviteAgentParams = Static<typeof InviteAgentParamsSchema>;
export type HelloOk = Static<typeof HelloOkSchema>;
export type OwnedAgent = Static<typeof OwnedAgentSchema>;
export type AgentsLookupParams = Static<typeof AgentsLookupParamsSchema>;
export type AgentsLookupResult = Static<typeof AgentsLookupResultSchema>;
export type AgentsLookupByNameParams = Static<
  typeof AgentsLookupByNameParamsSchema
>;
export type AgentsLookupByNameResult = Static<
  typeof AgentsLookupByNameResultSchema
>;
export type AgentsListParams = Static<typeof AgentsListParamsSchema>;
export type AgentsListResult = Static<typeof AgentsListResultSchema>;
