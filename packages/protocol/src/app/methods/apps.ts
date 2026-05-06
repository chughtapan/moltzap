import { Type, type Static } from "@sinclair/typebox";
import {
  AgentId,
  ConversationId,
  MessageId,
  TaskId,
} from "../../schema/primitives.js";
import { AppManifestSchema } from "../../schema/apps.js";
import { PartSchema } from "../../schema/messages.js";
import { LogicalClockSchema } from "../../schema/logical-clock.js";
import { DateTimeString } from "../../helpers.js";
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

/**
 * Verdict from a `task/authorizeDispatch` admission round-trip.
 * Discriminated by `decision`: `grant` (allow; optional lease for held
 * delivery), `deny` (reject), `hold` (defer behind a lease the TM will
 * release later).
 *
 * Phase 9b consumer-migration (sub-issue #460): the verdict shape stays
 * frozen across the rename `apps/onBeforeDispatch → task/authorizeDispatch`
 * because werewolf actively uses each variant for game-rule scheduling.
 * Pre-rename, this schema lived alongside the deleted `before_dispatch`
 * server-side framing; post-rename it is the receive-side TM-as-endpoint
 * gate.
 */
export const DispatchAdmissionDecisionSchema = Type.Union([
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

export type DispatchAdmissionResult = Static<
  typeof DispatchAdmissionDecisionSchema
>;

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
      admission: DispatchAdmissionDecisionSchema,
    },
    { additionalProperties: false },
  ),
});

// ─────────────────────────────────────────────────────────────────────────────
// task/authorizeDispatch — receive-side admission round-trip.
//
// Phase 9b consumer-migration (sub-issue #460, plan §2.4 + §2.4.a):
// renamed from the deleted `apps/onBeforeDispatch`. The wire RPC is still
// server-initiated awaitable — server asks the recipient's TM whether to
// admit the inbound message — but the framing drops the "before_dispatch"
// hook vocabulary in favour of the TM-as-endpoint topology. Verdict shape
// (`DispatchAdmissionDecisionSchema`) is preserved so werewolf's dispatch
// state machine continues to work without arena-side changes (Phase 11
// absorbs arena's submodule cutover).
//
// The other three pre-rename appCallback verbs (`apps/onBeforeMessageDelivery`,
// `apps/onSessionActive`, `apps/onClose`) are deleted in Phase 9b (plan
// §2.4): the TM's main message handler IS the gate now, and lifecycle
// notifications (`task/admissionComplete`, `task/closed`) replace the
// awaitable lifecycle hooks. The shared `appCallbackRpcMethods` group
// retires; `taskCallbackRpcMethods` houses the renamed verb.
// ─────────────────────────────────────────────────────────────────────────────

const HookSenderSchema = Type.Object(
  {
    agentId: AgentId,
    ownerId: Type.String(),
  },
  { additionalProperties: false },
);

/**
 * Lifecycle-agent schema reused by notifications carrying actor identity
 * (`task/closed`'s `closedBy` field). Phase 9b consumer-migration
 * (sub-issue #460): the lifecycle hook RPCs that originally introduced
 * this shape (`apps/onClose`'s context) retired; the notification frame
 * still carries the same shape, so the export survives.
 */
export const LifecycleAgentSchema = Type.Object(
  {
    agentId: AgentId,
    ownerId: Type.String(),
  },
  { additionalProperties: false },
);

/**
 * Context passed to a `task/authorizeDispatch` admission round-trip.
 * Mirrors the server-side `TaskAuthorizeDispatchContext` minus runtime-only
 * fields (`signal`).
 */
export const TaskAuthorizeDispatchContextSchema = Type.Object(
  {
    taskId: TaskId,
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

export type TaskAuthorizeDispatchContext = Static<
  typeof TaskAuthorizeDispatchContextSchema
>;

export const TaskAuthorizeDispatch = defineRpc({
  name: "task/authorizeDispatch",
  params: TaskAuthorizeDispatchContextSchema,
  result: Type.Object(
    { admission: DispatchAdmissionDecisionSchema },
    { additionalProperties: false },
  ),
});
