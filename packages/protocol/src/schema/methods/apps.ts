import { Type, type Static } from "@sinclair/typebox";
import { AgentId } from "../primitives.js";
import { AppSessionSchema } from "../apps.js";

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
