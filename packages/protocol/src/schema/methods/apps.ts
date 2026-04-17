import { Type, type Static } from "@sinclair/typebox";
import { AgentId } from "../primitives.js";
import { AppSessionSchema } from "../apps.js";
import { DateTimeString, stringEnum } from "../../helpers.js";
import { defineRpc } from "../../rpc.js";

export const AppsCreate = defineRpc({
  name: "apps/create",
  params: Type.Object(
    {
      appId: Type.String(),
      invitedAgentIds: Type.Array(AgentId),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { session: AppSessionSchema },
    { additionalProperties: false },
  ),
});

export const AppsAttestSkill = defineRpc({
  name: "apps/attestSkill",
  params: Type.Object(
    {
      challengeId: Type.String({ format: "uuid" }),
      skillUrl: Type.String(),
      version: Type.String(),
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export const PermissionsGrant = defineRpc({
  name: "permissions/grant",
  params: Type.Object(
    {
      sessionId: Type.String({ format: "uuid" }),
      agentId: AgentId,
      resource: Type.String(),
      access: Type.Array(Type.String()),
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export const PermissionsList = defineRpc({
  name: "permissions/list",
  params: Type.Object(
    {
      appId: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
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
  ),
});

export const PermissionsRevoke = defineRpc({
  name: "permissions/revoke",
  params: Type.Object(
    {
      appId: Type.String(),
      resource: Type.String(),
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export const AppsCloseSession = defineRpc({
  name: "apps/closeSession",
  params: Type.Object(
    {
      sessionId: Type.String({ format: "uuid" }),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      closed: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
});

export const AppsGetSession = defineRpc({
  name: "apps/getSession",
  params: Type.Object(
    {
      sessionId: Type.String({ format: "uuid" }),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      session: AppSessionSchema,
    },
    { additionalProperties: false },
  ),
});

export const AppsListSessions = defineRpc({
  name: "apps/listSessions",
  params: Type.Object(
    {
      appId: Type.Optional(Type.String()),
      status: Type.Optional(stringEnum(["waiting", "active", "closed"])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      sessions: Type.Array(AppSessionSchema),
    },
    { additionalProperties: false },
  ),
});
