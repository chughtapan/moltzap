import { Type, type Static } from "@sinclair/typebox";
import { AgentId } from "../primitives.js";
import { AppSessionSchema } from "../apps.js";
import { DateTimeString } from "../../helpers.js";

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

export const PermissionsGrantParamsSchema = Type.Object(
  {
    sessionId: Type.String({ format: "uuid" }),
    agentId: AgentId,
    resource: Type.String(),
    access: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const PermissionsGrantResultSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const PermissionsListParamsSchema = Type.Object(
  {
    appId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export const PermissionsListResultSchema = Type.Object(
  {
    grants: Type.Array(
      Type.Object(
        {
          appId: Type.String(),
          resource: Type.String(),
          access: Type.Array(Type.String()),
          grantedAt: DateTimeString,
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export const PermissionsRevokeParamsSchema = Type.Object(
  {
    appId: Type.String(),
    resource: Type.String(),
  },
  { additionalProperties: false },
);

export const PermissionsRevokeResultSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export type AppsCreateParams = Static<typeof AppsCreateParamsSchema>;
export type AppsCreateResult = Static<typeof AppsCreateResultSchema>;
export type AppsAttestSkillParams = Static<typeof AppsAttestSkillParamsSchema>;
export type AppsAttestSkillResult = Static<typeof AppsAttestSkillResultSchema>;
export type PermissionsGrantParams = Static<
  typeof PermissionsGrantParamsSchema
>;
export type PermissionsGrantResult = Static<
  typeof PermissionsGrantResultSchema
>;
export type PermissionsListParams = Static<typeof PermissionsListParamsSchema>;
export type PermissionsListResult = Static<typeof PermissionsListResultSchema>;
export type PermissionsRevokeParams = Static<
  typeof PermissionsRevokeParamsSchema
>;
export type PermissionsRevokeResult = Static<
  typeof PermissionsRevokeResultSchema
>;
