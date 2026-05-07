// App-layer manifest. File outline:
//   1. App manifest schema (AppManifestSchema, AppManifest)  lines  8–58
//   2. apps/* RPCs (AppsRegister, AppsAuthorizeDispatch)     lines 60–138
//   3. task callback descriptor (TaskAuthorizeDispatch)      lines 140–169
//   4. Aggregator arrays                                      lines 170–174
import { Type, type Static } from "@sinclair/typebox";
import { AgentId, AgentOwnershipSchema } from "../identity/methods.js";
import { ConversationId, MessageId, TaskId } from "../task/methods.js";
import { MessagePartsSchema, LogicalClockSchema } from "../task/methods.js";
import { DateTimeString, stringEnum } from "../schema-primitives.js";
import { defineRpc } from "../transport/method.js";

// ── App manifest schema ──────────────────────────────────────────────

const AppManifestConversationSchema = Type.Object(
  {
    key: Type.String(),
    name: Type.String(),
    participantFilter: Type.Optional(stringEnum(["all", "initiator", "none"])),
  },
  { additionalProperties: false },
);

/**
 * Per-hook configuration entry. The lone surviving hook entry post
 * Phase 9b is `task_authorize_dispatch`; only `timeout_ms` is
 * configurable today.
 */
const HookEntrySchema = Type.Object(
  {
    timeout_ms: Type.Optional(Type.Integer({ default: 5000, minimum: 1 })),
  },
  { additionalProperties: false },
);

export const AppManifestSchema = Type.Object(
  {
    appId: Type.String(),
    name: Type.String(),
    description: Type.Optional(Type.String()),
    limits: Type.Optional(
      Type.Object(
        {
          maxParticipants: Type.Optional(Type.Integer({ default: 50 })),
        },
        { additionalProperties: false },
      ),
    ),
    conversations: Type.Optional(Type.Array(AppManifestConversationSchema)),
    hooks: Type.Optional(
      Type.Object(
        {
          task_authorize_dispatch: Type.Optional(HookEntrySchema),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

export type AppManifest = Static<typeof AppManifestSchema>;

// ── apps/* RPCs ──────────────────────────────────────────────────────

export const AppsRegister = defineRpc({
  name: "apps/register",
  params: Type.Object(
    { manifest: AppManifestSchema },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { appId: Type.String() },
    { additionalProperties: false },
  ),
});

const DispatchAdmissionDecisionSchema = Type.Union([
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

const PendingMessageSchema = Type.Object(
  {
    messageId: MessageId,
    conversationId: ConversationId,
    senderAgentId: AgentId,
    createdAt: DateTimeString,
    receivedAt: DateTimeString,
    clock: Type.Optional(LogicalClockSchema),
    parts: Type.Optional(MessagePartsSchema),
  },
  { additionalProperties: false },
);

const PendingMessageArraySchema = Type.Array(PendingMessageSchema, {
  maxItems: 100,
});

export const AppsAuthorizeDispatch = defineRpc({
  name: "apps/authorizeDispatch",
  params: Type.Object(
    {
      conversationId: ConversationId,
      messageId: MessageId,
      senderAgentId: AgentId,
      parts: Type.Optional(MessagePartsSchema),
      receivedAt: Type.Optional(DateTimeString),
      pending: Type.Optional(PendingMessageArraySchema),
      clock: Type.Optional(LogicalClockSchema),
      attempt: Type.Optional(Type.Integer({ minimum: 0 })),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { admission: DispatchAdmissionDecisionSchema },
    { additionalProperties: false },
  ),
});

const TaskAuthorizeDispatchContextSchema = Type.Object(
  {
    taskId: TaskId,
    appId: Type.String(),
    conversationId: ConversationId,
    recipient: AgentOwnershipSchema,
    message: Type.Object(
      {
        id: MessageId,
        senderAgentId: AgentId,
        parts: Type.Optional(MessagePartsSchema),
      },
      { additionalProperties: false },
    ),
    attempt: Type.Integer({ minimum: 0 }),
    receivedAt: Type.Optional(DateTimeString),
    clock: Type.Optional(LogicalClockSchema),
    pending: Type.Optional(PendingMessageArraySchema),
  },
  { additionalProperties: false },
);

export const TaskAuthorizeDispatch = defineRpc({
  name: "task/authorizeDispatch",
  params: TaskAuthorizeDispatchContextSchema,
  result: Type.Object(
    { admission: DispatchAdmissionDecisionSchema },
    { additionalProperties: false },
  ),
});

export const appRpcMethods = [AppsRegister, AppsAuthorizeDispatch] as const;

export const taskCallbackMethods = [TaskAuthorizeDispatch] as const;

export const appNotifications = [] as const;
