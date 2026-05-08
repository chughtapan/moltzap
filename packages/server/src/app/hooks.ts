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

export interface AppHooks {
  taskAuthorizeDispatch?: TaskAuthorizeDispatchHook;
}
