import type { LogicalClock, Part, Static } from "@moltzap/protocol";
import { MessageId } from "@moltzap/protocol/schemas/primitives";
import { Schema } from "effect";

type MessageIdValue = Static<typeof MessageId>;

/**
 * Phase 9b consumer-migration (sub-issue #460, plan §2.4): the legacy
 * server-side hook surface (`BeforeMessageDeliveryContext`,
 * `OnCloseContext`, `OnSessionActiveContext`, plus the matching `Hook`
 * type aliases) was deleted with the wire RPCs `apps/onBeforeMessageDelivery`,
 * `apps/onSessionActive`, `apps/onClose`. Only `task/authorizeDispatch`
 * (renamed from `apps/onBeforeDispatch`) survives.
 *
 * The `BeforeDispatch*` names retire alongside the wire rename — the
 * surviving server-side context type and hook alias are
 * `TaskAuthorizeDispatchContext` and `TaskAuthorizeDispatchHook`.
 */
export interface TaskAuthorizeDispatchContext {
  conversationId: string;
  recipient: { agentId: string; ownerId: string };
  message: { id: string; senderAgentId: string; parts?: Part[] };
  taskId: string;
  appId: string;
  attempt: number;
  receivedAt?: string;
  clock?: LogicalClock;
  pending?: ReadonlyArray<{
    messageId: string;
    conversationId: string;
    senderAgentId: string;
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
      dispatchMessageId?: MessageIdValue;
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
 * Wire-envelope schema for `task/authorizeDispatch`. The reply arrives as
 * `{ admission: ... }`, not the bare verdict. Decoding at the RPC edge
 * keeps AppHost's business logic typed (Principle 2: schemas at
 * boundaries, types inside).
 */
export const TaskAuthorizeDispatchRpcResultSchema = Schema.Struct({
  admission: DispatchAdmissionResultSchema,
}) as Schema.Schema<{ admission: DispatchAdmissionResult }, unknown>;

/**
 * Module-level precompiled decoder. `Schema.decodeUnknown(schema)`
 * produces a fresh closure each call; lifting the decoder here means
 * the per-dispatch hot path (`runRemoteHookEffect` → `decode`) reuses
 * one closure.
 */
export const decodeTaskAuthorizeDispatchRpcResult = Schema.decodeUnknown(
  TaskAuthorizeDispatchRpcResultSchema,
);

export type TaskAuthorizeDispatchHook = (
  ctx: TaskAuthorizeDispatchContext,
) => DispatchAdmissionResult | Promise<DispatchAdmissionResult>;

export interface AppHooks {
  taskAuthorizeDispatch?: TaskAuthorizeDispatchHook;
}
