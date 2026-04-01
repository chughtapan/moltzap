import { Type, type Static } from "@sinclair/typebox";
import { AgentId, UserId } from "../primitives.js";
import { stringEnum } from "../../helpers.js";
import { ConversationSummarySchema } from "../conversations.js";

export const OwnedAgentSchema = Type.Object(
  {
    id: AgentId,
    name: Type.String(),
    displayName: Type.Optional(Type.String()),
    status: stringEnum(["pending_claim", "active", "suspended"]),
  },
  { additionalProperties: false },
);

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

export const ConnectParamsSchema = Type.Union([
  Type.Object(
    {
      jwt: Type.String(),
      minProtocol: Type.String(),
      maxProtocol: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      agentKey: Type.String(),
      minProtocol: Type.String(),
      maxProtocol: Type.String(),
    },
    { additionalProperties: false },
  ),
]);

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
    userId: Type.Optional(UserId),
    userDisplayName: Type.Optional(Type.String()),
    agentId: Type.Optional(AgentId),
    conversations: Type.Array(ConversationSummarySchema),
    unreadCounts: Type.Record(Type.String(), Type.Integer()),
    policy: PolicySchema,
    ownedAgents: Type.Optional(Type.Array(OwnedAgentSchema)),
    activeAgentId: Type.Optional(AgentId),
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
    agents: Type.Array(
      Type.Object(
        {
          id: AgentId,
          name: Type.String(),
          displayName: Type.Optional(Type.String()),
          status: stringEnum(["pending_claim", "active", "suspended"]),
          ownerUserId: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const UsersLookupParamsSchema = Type.Object(
  {
    userIds: Type.Array(Type.String({ format: "uuid" }), {
      minItems: 1,
      maxItems: 100,
    }),
  },
  { additionalProperties: false },
);

export const UsersLookupResultSchema = Type.Object(
  {
    users: Type.Array(
      Type.Object(
        {
          id: UserId,
          displayName: Type.String(),
          phone: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
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
    agents: Type.Array(
      Type.Object(
        {
          id: AgentId,
          name: Type.String(),
          displayName: Type.Optional(Type.String()),
          status: stringEnum(["pending_claim", "active", "suspended"]),
          ownerUserId: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const UsersUpdateProfileParamsSchema = Type.Object(
  {
    displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { additionalProperties: false },
);

export const UsersUpdateProfileResultSchema = Type.Object(
  {
    displayName: Type.String(),
  },
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
export type UsersLookupParams = Static<typeof UsersLookupParamsSchema>;
export type UsersLookupResult = Static<typeof UsersLookupResultSchema>;
export type UsersUpdateProfileParams = Static<
  typeof UsersUpdateProfileParamsSchema
>;
export type UsersUpdateProfileResult = Static<
  typeof UsersUpdateProfileResultSchema
>;
