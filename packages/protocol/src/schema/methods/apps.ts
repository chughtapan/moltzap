import { Type, type Static } from "@sinclair/typebox";
import { AgentId } from "../primitives.js";
import { AppSessionSchema } from "../apps.js";
import { stringEnum } from "../../helpers.js";

export const AppsCreateParamsSchema = Type.Object(
  {
    appId: Type.String(),
    invitedAgentIds: Type.Array(AgentId),
  },
  { additionalProperties: false },
);

export const AppsCreateResultSchema = Type.Object(
  { session: AppSessionSchema },
  { additionalProperties: false },
);

export const AppsAttestSkillParamsSchema = Type.Object(
  {
    challengeId: Type.String({ format: "uuid" }),
    skillUrl: Type.String(),
    version: Type.String(),
  },
  { additionalProperties: false },
);

export const AppsAttestSkillResultSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const AppsGrantPermissionParamsSchema = Type.Object(
  {
    sessionId: Type.String({ format: "uuid" }),
    agentId: AgentId,
    resource: Type.String(),
    access: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const AppsGrantPermissionResultSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export type AppsCreateParams = Static<typeof AppsCreateParamsSchema>;
export type AppsCreateResult = Static<typeof AppsCreateResultSchema>;
export type AppsAttestSkillParams = Static<typeof AppsAttestSkillParamsSchema>;
export type AppsAttestSkillResult = Static<typeof AppsAttestSkillResultSchema>;
export type AppsGrantPermissionParams = Static<
  typeof AppsGrantPermissionParamsSchema
>;
export type AppsGrantPermissionResult = Static<
  typeof AppsGrantPermissionResultSchema
>;

// Close session

export const AppsCloseSessionParamsSchema = Type.Object(
  {
    sessionId: Type.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);

export const AppsCloseSessionResultSchema = Type.Object(
  {
    closed: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type AppsCloseSessionParams = Static<
  typeof AppsCloseSessionParamsSchema
>;
export type AppsCloseSessionResult = Static<
  typeof AppsCloseSessionResultSchema
>;

// Get session

export const AppsGetSessionParamsSchema = Type.Object(
  {
    sessionId: Type.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);

export const AppsGetSessionResultSchema = Type.Object(
  {
    session: AppSessionSchema,
  },
  { additionalProperties: false },
);

export type AppsGetSessionParams = Static<typeof AppsGetSessionParamsSchema>;
export type AppsGetSessionResult = Static<typeof AppsGetSessionResultSchema>;

// List sessions

export const AppsListSessionsParamsSchema = Type.Object(
  {
    appId: Type.Optional(Type.String()),
    status: Type.Optional(stringEnum(["waiting", "active", "closed"])),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: false },
);

export const AppsListSessionsResultSchema = Type.Object(
  {
    sessions: Type.Array(AppSessionSchema),
  },
  { additionalProperties: false },
);

export type AppsListSessionsParams = Static<
  typeof AppsListSessionsParamsSchema
>;
export type AppsListSessionsResult = Static<
  typeof AppsListSessionsResultSchema
>;
