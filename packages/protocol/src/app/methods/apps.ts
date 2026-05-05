import { Type, type Static } from "@sinclair/typebox";
import { AgentId, ConversationId, MessageId } from "../../schema/primitives.js";
import { AppManifestSchema, AppSessionSchema } from "../../schema/apps.js";
import { PartSchema } from "../../schema/messages.js";
import { LogicalClockSchema } from "../../schema/logical-clock.js";
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

/**
 * Verdict from a `before_dispatch` admission handler. Discriminated by
 * `decision`: `grant` (allow; optional lease for held delivery), `deny`
 * (reject), `hold` (defer behind a lease the app will release later).
 *
 * Re-exported from `@moltzap/app-sdk` as `DispatchAdmissionResult`.
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
// Admission + lifecycle RPC verbs.
//
// All four appCallback verbs are AWAITABLE — `onSessionActive` / `onClose`
// reply with an empty object so AppHost can `Deferred.await` and apply the
// manifest hook timeout. They are NOT fire-and-forget; `app/sessionReady`
// delivery is gated on the `onSessionActive` reply (existing ordering
// invariant — see `31-on-session-active.integration.test.ts:200-230`).
//
// Verdict shapes mirror `packages/server/src/app/hooks.ts` verbatim — the
// `DispatchAdmissionDecisionSchema` constant defined above (and reused here) is the
// same union, and `HookResultSchema` matches `HookResult` field-for-field.
// Adding a new verdict tag is a protocol change; do it in the spec, not here.
//
// `apps/attachConversation` is client-originated and is registered in the
// `rpcMethods` tuple, not `appCallbackRpcMethods`.
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

/**
 * Verdict from a `before_message_delivery` admission handler. `block: true`
 * drops the message; `block: false` allows. Optional `patch.parts` mutates
 * the recipient view; optional `feedback` emits an observability hook.
 *
 * Re-exported from `@moltzap/app-sdk` as `HookResult`.
 */
export const HookResultSchema = Type.Object(
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

export type HookResult = Static<typeof HookResultSchema>;

/**
 * Context passed to a `before_dispatch` admission handler. Mirrors the
 * server-side `BeforeDispatchContext` minus runtime-only fields (`signal`).
 */
export const BeforeDispatchContextSchema = Type.Object(
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

export type BeforeDispatchContext = Static<typeof BeforeDispatchContextSchema>;

/**
 * Context passed to a `before_message_delivery` admission handler.
 */
export const BeforeMessageDeliveryContextSchema = Type.Object(
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

export type BeforeMessageDeliveryContext = Static<
  typeof BeforeMessageDeliveryContextSchema
>;

const LifecycleAgentSchema = Type.Object(
  {
    agentId: AgentId,
    ownerId: Type.String(),
  },
  { additionalProperties: false },
);

/** Context passed to an `on_close` lifecycle handler. */
export const OnCloseContextSchema = Type.Object(
  {
    sessionId: Type.String({ format: "uuid" }),
    appId: Type.String(),
    conversations: Type.Record(Type.String(), Type.String()),
    closedBy: LifecycleAgentSchema,
  },
  { additionalProperties: false },
);

export type OnCloseContext = Static<typeof OnCloseContextSchema>;

/** Context passed to an `on_session_active` lifecycle handler. */
export const OnSessionActiveContextSchema = Type.Object(
  {
    sessionId: Type.String({ format: "uuid" }),
    appId: Type.String(),
    conversations: Type.Record(Type.String(), Type.String()),
    admittedAgentIds: Type.Array(AgentId),
  },
  { additionalProperties: false },
);

export type OnSessionActiveContext = Static<
  typeof OnSessionActiveContextSchema
>;

/** Empty result envelope for awaitable-void appCallback hooks. The reply still
 *  round-trips so AppHost can `Deferred.await` and apply manifest timeout. */
const VoidHookResultSchema = Type.Object({}, { additionalProperties: false });

export const AppsOnBeforeDispatch = defineRpc({
  name: "apps/onBeforeDispatch",
  params: BeforeDispatchContextSchema,
  result: Type.Object(
    { admission: DispatchAdmissionDecisionSchema },
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
