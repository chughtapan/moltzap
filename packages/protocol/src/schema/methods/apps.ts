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

// ─────────────────────────────────────────────────────────────────────────────
// PHASE 1.1 STUBS — admission RPC verbs (server-initiated) and apps/attachConversation.
//
// All five s2c verbs are AWAITABLE (NOT fire-and-forget):
//   - onBeforeDispatch / onBeforeMessageDelivery → carry verdict in result.
//   - onSessionActive / onJoin / onClose → awaitable void; AppHost waits for
//     completion before emitting `app/sessionReady` (per
//     31-on-session-active.integration.test.ts:200-230) and analogous ordering
//     for the other lifecycle hooks. Result schema = empty object so the
//     reply round-trip happens; payload is ignored.
//
// VERDICT SHAPES PRESERVED — DO NOT INVENT NEW SHAPES:
//   - `DispatchAdmissionResult` matches `app/hooks.ts:72-80` exactly:
//     grant + leaseId + leaseTimeoutMs + dispatchMessageId | deny + reason | hold + reason.
//     `DispatchAdmissionDecision` constant above is already that shape and
//     is reused below by `AppsOnBeforeDispatch`.
//   - `HookResult` matches `app/hooks.ts:34-43`: { block, reason?, patch?, feedback? }.
//
// SCHEMA REGISTRATION: implementer (B.1) adds these definitions to a NEW
// `s2cRpcMethods` tuple parallel to `rpcMethods` in `rpc-registry.ts`, with
// a parallel `S2cRpcMap` and `S2cRpcMethodName`. Direction-namespaced so c2s
// dispatch (server router) cannot collide with s2c dispatch (client handler
// registry).
//
// `apps/attachConversation` is c2s (client-originated) and therefore registers
// in the existing `rpcMethods` tuple alongside `apps/closeSession` etc.
// ─────────────────────────────────────────────────────────────────────────────

const HookSenderSchema = Type.Object(
  {
    agentId: AgentId,
    ownerId: Type.String(),
  },
  { additionalProperties: false },
);

const HookFeedbackSchema = Type.Object(
  {
    type: stringEnum(["error", "warning", "info"]),
    content: Type.Record(Type.String(), Type.Unknown()),
    retry: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const HookResultSchema = Type.Object(
  {
    block: Type.Boolean(),
    reason: Type.Optional(Type.String()),
    patch: Type.Optional(
      Type.Object(
        { parts: Type.Array(PartSchema, { minItems: 1, maxItems: 10 }) },
        { additionalProperties: false },
      ),
    ),
    feedback: Type.Optional(HookFeedbackSchema),
  },
  { additionalProperties: false },
);

const BeforeDispatchContextSchema = Type.Object(
  {
    sessionId: Type.String({ format: "uuid" }),
    appId: Type.String(),
    conversationId: ConversationId,
    recipient: HookSenderSchema,
    message: Type.Object(
      {
        id: MessageId,
        senderAgentId: AgentId,
        parts: Type.Optional(
          Type.Array(PartSchema, { minItems: 1, maxItems: 10 }),
        ),
      },
      { additionalProperties: false },
    ),
    attempt: Type.Integer({ minimum: 0 }),
    receivedAt: Type.Optional(DateTimeString),
    clock: Type.Optional(LogicalClockSchema),
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
  },
  { additionalProperties: false },
);

const BeforeMessageDeliveryContextSchema = Type.Object(
  {
    sessionId: Type.String({ format: "uuid" }),
    appId: Type.String(),
    conversationId: ConversationId,
    sender: HookSenderSchema,
    message: Type.Object(
      {
        parts: Type.Array(PartSchema, { minItems: 1, maxItems: 10 }),
        replyToId: Type.Optional(MessageId),
        dispatchLeaseId: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

const LifecycleAgentSchema = Type.Object(
  {
    agentId: AgentId,
    ownerId: Type.String(),
  },
  { additionalProperties: false },
);

const OnJoinContextSchema = Type.Object(
  {
    sessionId: Type.String({ format: "uuid" }),
    appId: Type.String(),
    conversations: Type.Record(Type.String(), Type.String()),
    agent: LifecycleAgentSchema,
  },
  { additionalProperties: false },
);

const OnCloseContextSchema = Type.Object(
  {
    sessionId: Type.String({ format: "uuid" }),
    appId: Type.String(),
    conversations: Type.Record(Type.String(), Type.String()),
    closedBy: LifecycleAgentSchema,
  },
  { additionalProperties: false },
);

const OnSessionActiveContextSchema = Type.Object(
  {
    sessionId: Type.String({ format: "uuid" }),
    appId: Type.String(),
    conversations: Type.Record(Type.String(), Type.String()),
    admittedAgentIds: Type.Array(AgentId),
  },
  { additionalProperties: false },
);

/** Empty result envelope for awaitable-void s2c hooks. The reply still
 *  round-trips so AppHost can `Deferred.await` and apply manifest timeout. */
const VoidHookResultSchema = Type.Object({}, { additionalProperties: false });

export const AppsOnBeforeDispatch = defineRpc({
  name: "apps/onBeforeDispatch",
  params: BeforeDispatchContextSchema,
  result: Type.Object(
    { admission: DispatchAdmissionDecision },
    { additionalProperties: false },
  ),
});

export const AppsOnBeforeMessageDelivery = defineRpc({
  name: "apps/onBeforeMessageDelivery",
  params: BeforeMessageDeliveryContextSchema,
  result: HookResultSchema,
});

export const AppsOnSessionActive = defineRpc({
  name: "apps/onSessionActive",
  params: OnSessionActiveContextSchema,
  result: VoidHookResultSchema,
});

export const AppsOnJoin = defineRpc({
  name: "apps/onJoin",
  params: OnJoinContextSchema,
  result: VoidHookResultSchema,
});

export const AppsOnClose = defineRpc({
  name: "apps/onClose",
  params: OnCloseContextSchema,
  result: VoidHookResultSchema,
});

/**
 * `apps/attachConversation` — client-originated. Adds an existing conversation
 * to a session's membership/role-DM pipeline. Mirrors today's in-process
 * `AppHost.attachConversation` (see 33-attach-conversation.integration.test.ts:312-369).
 *
 * Error channel (implementer wires via RpcResponseError codes):
 *   - SessionNotFound
 *   - ConversationNotFound
 *   - NotAuthorized (caller's app key does not own the session)
 */
export const AppsAttachConversation = defineRpc({
  name: "apps/attachConversation",
  params: Type.Object(
    {
      sessionId: Type.String({ format: "uuid" }),
      conversationId: ConversationId,
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});
