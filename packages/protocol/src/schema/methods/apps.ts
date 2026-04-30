import { Type } from "@sinclair/typebox";
import { AgentId, ConversationId, MessageId } from "../primitives.js";
import { AppManifestSchema, AppSessionSchema } from "../apps.js";
import { PartSchema } from "../messages.js";
import { LogicalClockSchema } from "../logical-clock.js";
import { DateTimeString, stringEnum } from "../../helpers.js";
import { defineRpc } from "../../rpc.js";

export const AppsRegister = defineRpc({
  name: "apps/register",
  params: Type.Object(
    {
      manifest: AppManifestSchema,
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      appId: Type.String(),
    },
    { additionalProperties: false },
  ),
});

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

const DispatchAdmissionDecision = Type.Union([
  Type.Object(
    {
      decision: Type.Literal("grant"),
      leaseId: Type.Optional(Type.String()),
      leaseTimeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
      dispatchMessageId: Type.Optional(MessageId),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      decision: Type.Literal("deny"),
      reason: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      decision: Type.Literal("hold"),
      reason: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
]);

export const AppsAuthorizeDispatch = defineRpc({
  name: "apps/authorizeDispatch",
  params: Type.Object(
    {
      conversationId: ConversationId,
      messageId: MessageId,
      senderAgentId: AgentId,
      parts: Type.Optional(
        Type.Array(PartSchema, { minItems: 1, maxItems: 10 }),
      ),
      receivedAt: Type.Optional(DateTimeString),
      pending: Type.Optional(
        Type.Array(
          Type.Object(
            {
              messageId: MessageId,
              conversationId: ConversationId,
              senderAgentId: AgentId,
              createdAt: DateTimeString,
              receivedAt: DateTimeString,
              clock: Type.Optional(LogicalClockSchema),
              parts: Type.Optional(
                Type.Array(PartSchema, { minItems: 1, maxItems: 10 }),
              ),
            },
            { additionalProperties: false },
          ),
          { maxItems: 100 },
        ),
      ),
      clock: Type.Optional(LogicalClockSchema),
      attempt: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      admission: DispatchAdmissionDecision,
    },
    { additionalProperties: false },
  ),
});
