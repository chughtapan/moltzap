import type { LogicalClock, Part } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId, MessageId, TaskId } from "@moltzap/protocol/task";
import { Schema } from "effect";

/**
 * Server-side dispatch admission hook surface. The single hook
 * (`taskAuthorizeDispatch`) services the `dispatch/authorize` S→C RPC;
 * its context shape mirrors the wire `DispatchAuthorizeContextSchema`.
 * The legacy server-side names (`TaskAuthorizeDispatchContext` /
 * `TaskAuthorizeDispatchHook`) are retained for stability of in-tree
 * server consumers (in-process moderator registrations).
 */
export interface TaskAuthorizeDispatchContext {
  conversationId: ConversationId;
  recipient: { agentId: AgentId; ownerId: string };
  message: { id: MessageId; senderAgentId: AgentId; parts?: Part[] };
  taskId: TaskId;
  appId: string;
  attempt: number;
  receivedAt?: string;
  clock?: LogicalClock;
  pending?: ReadonlyArray<{
    messageId: MessageId;
    conversationId: ConversationId;
    senderAgentId: AgentId;
    createdAt: string;
    receivedAt: string;
    clock?: LogicalClock;
    parts?: Part[];
  }>;
  signal: AbortSignal;
}

export type DispatchAdmissionResult =
  | {
      decision: "grant";
      leaseId?: string;
      leaseTimeoutMs?: number;
      dispatchMessageId?: MessageId;
    }
  | { decision: "deny"; reason?: string }
  | { decision: "hold"; reason?: string };

export const DispatchAdmissionResultSchema = Schema.Union(
  Schema.Struct({
    decision: Schema.Literal("grant"),
    leaseId: Schema.optional(Schema.String),
    leaseTimeoutMs: Schema.optional(Schema.Number),
    dispatchMessageId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    decision: Schema.Literal("deny"),
    reason: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    decision: Schema.Literal("hold"),
    reason: Schema.optional(Schema.String),
  }),
) as Schema.Schema<DispatchAdmissionResult, unknown>;

/**
 * Wire-envelope schema for `dispatch/authorize`. The reply arrives as
 * `{ admission: ... }`, not the bare verdict. Decoding at the RPC edge
 * keeps AppHost's business logic typed (Principle 2: schemas at
 * boundaries, types inside).
 */
export const DispatchAuthorizeRpcResultSchema = Schema.Struct({
  admission: DispatchAdmissionResultSchema,
}) as Schema.Schema<{ admission: DispatchAdmissionResult }, unknown>;

/**
 * Module-level precompiled decoder.
 */
export const decodeDispatchAuthorizeRpcResult = Schema.decodeUnknown(
  DispatchAuthorizeRpcResultSchema,
);

export type TaskAuthorizeDispatchHook = (
  ctx: TaskAuthorizeDispatchContext,
) => DispatchAdmissionResult | Promise<DispatchAdmissionResult>;

/**
 * Server-side message-fan-out authorization hook surface (#560). The
 * hook (`messageAuthorize`) services the `messages/authorize` S→C RPC;
 * its context shape mirrors the wire `MessagesAuthorizeContextSchema`.
 *
 * This hook restores the send-side gate that Phase 9b (#461) deleted
 * by removing `apps/onBeforeMessageDelivery` without an equivalent on
 * the new wire surface. Verdict shape is the 2-arm subset of #142's
 * 5-arm `TaskManagerAction`: `Forward { recipients } | Block { reason }`.
 *
 * Symmetric to `TaskAuthorizeDispatchHook`: same context fields
 * (`taskId`, `appId`, `conversationId`, `message`, `receivedAt`,
 * `clock`), same fail-closed posture, different verdict union.
 */
export interface MessageAuthorizeContext {
  conversationId: ConversationId;
  message: { id: MessageId; senderAgentId: AgentId; parts?: Part[] };
  taskId: TaskId;
  appId: string;
  receivedAt?: string;
  clock?: LogicalClock;
  signal: AbortSignal;
}

/**
 * 2-arm verdict the TM declares for fan-out. `Forward { recipients }`
 * names the agents the server SHALL deliver to; `Block { reason }`
 * suppresses fan-out and surfaces `RpcFailure(HookBlocked)` to the
 * sender. `recipients` MUST be a subset of the conversation's
 * participants; the server does not re-fan to non-participants.
 * Empty `recipients` is legal — message lands in the sender's
 * transcript but is delivered to no one else.
 *
 * The remaining `Modify | Close | AttachConversation` arms from
 * #142's 5-arm spec are out of scope for #560; see the design doc
 * §11 for rationale.
 */
export type MessageAuthorizeResult =
  | { decision: "Forward"; recipients: ReadonlyArray<AgentId> }
  | { decision: "Block"; reason?: string };

export const MessageAuthorizeResultSchema = Schema.Union(
  Schema.Struct({
    decision: Schema.Literal("Forward"),
    recipients: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    decision: Schema.Literal("Block"),
    reason: Schema.optional(Schema.String),
  }),
) as Schema.Schema<MessageAuthorizeResult, unknown>;

/**
 * Wire-envelope schema for `messages/authorize`. The reply arrives as
 * `{ verdict: ... }`, not the bare verdict. Decoding at the RPC edge
 * keeps AppHost's business logic typed (Principle 2).
 */
export const MessageAuthorizeRpcResultSchema = Schema.Struct({
  verdict: MessageAuthorizeResultSchema,
}) as Schema.Schema<{ verdict: MessageAuthorizeResult }, unknown>;

export const decodeMessageAuthorizeRpcResult = Schema.decodeUnknown(
  MessageAuthorizeRpcResultSchema,
);

export type MessageAuthorizeHook = (
  ctx: MessageAuthorizeContext,
) => MessageAuthorizeResult | Promise<MessageAuthorizeResult>;

/**
 * `AppHooks` continues to key per-appId — `taskAuthorizeDispatch`
 * runs against the recipient's bound app, found via
 * `lookupAppForConversation`. `messageAuthorize` does NOT live here:
 * its lookup key is the TASK's `tm_endpoint_address`, not the bound
 * app. Default DM and default-group conversations have no bound app
 * but DO have a `tm_endpoint_address` (`DEFAULT_DM_TM_ADDRESS` /
 * `DEFAULT_GROUP_TM_ADDRESS` per `app-tm-registry.ts:30,38@adc2e18`),
 * so an address-keyed registry is the right shape.
 */
export interface AppHooks {
  taskAuthorizeDispatch?: TaskAuthorizeDispatchHook;
}
