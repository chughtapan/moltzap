import type { LogicalClock, Part } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId, MessageId, TaskId } from "@moltzap/protocol/task";

/**
 * Generic hook shape — single source of truth for the abstraction
 * shared by every server-side authorization hook. Specific hooks are
 * instantiations of this alias; registries that hold them stay
 * shape-aligned even when their key types differ.
 *
 * Today's instantiations (#560 v4 unification):
 *
 *   type TaskAuthorizeDispatchHook = Hook&lt;TaskAuthorizeDispatchContext,
 *                                         DispatchAdmissionResult>;
 *   type MessageAuthorizeHook      = Hook&lt;MessageAuthorizeContext,
 *                                         MessageAuthorizeResult>;
 *
 * The user-facing callback returns sync-or-Promise (matches existing
 * SDK ergonomics); the AppHost runner wraps the call into Effect and
 * applies the uniform fail-closed envelope. Future hooks land as
 * additional instantiations — adding a bespoke hook shape is a
 * doctrine violation (architect risk R13).
 */
type Hook<TContext, TResult> = (ctx: TContext) => TResult | Promise<TResult>;

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

export type TaskAuthorizeDispatchHook = Hook<
  TaskAuthorizeDispatchContext,
  DispatchAdmissionResult
>;

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

export type MessageAuthorizeHook = Hook<
  MessageAuthorizeContext,
  MessageAuthorizeResult
>;

/**
 * `AppHooks` keys per-appId. Today's single slot is the receive-side
 * `taskAuthorizeDispatch` hook (external moderator callback with
 * fail-closed envelope). `messageAuthorize` lives in
 * `AppHost.messageAuthorizeHooks` (separate appId-keyed map);
 * registration helper is `AppHost.registerMessageAuthorize`.
 */
export interface AppHooks {
  taskAuthorizeDispatch?: TaskAuthorizeDispatchHook;
}
