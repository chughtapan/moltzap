import type { LogicalClock, Part } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId, MessageId, TaskId } from "@moltzap/protocol/task";

/**
 * Generic shape shared by every server-side authorization hook. The
 * user-facing callback returns sync-or-Promise; the AppHost runner
 * wraps the call into Effect and applies the fail-closed envelope.
 * New hooks land as additional instantiations of this alias.
 */
type Hook<TContext, TResult> = (ctx: TContext) => TResult | Promise<TResult>;

/**
 * Server-side dispatch admission hook context. The single hook
 * (`taskAuthorizeDispatch`) services the `dispatch/authorize` S→C RPC;
 * its shape mirrors the wire `DispatchAuthorizeContextSchema`.
 */
export interface DispatchAuthorizeContext {
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

export type DispatchAuthorizeHook = Hook<
  DispatchAuthorizeContext,
  DispatchAdmissionResult
>;

/**
 * Server-side message-fan-out authorization hook context. The hook
 * (`messageAuthorize`) services the `messages/authorize` S→C RPC; its
 * shape mirrors the wire `MessagesAuthorizeContextSchema`. Symmetric
 * to `DispatchAuthorizeContext` — same fields, same fail-closed
 * posture, different verdict union.
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
 */
export type MessageAuthorizeResult =
  | { decision: "Forward"; recipients: ReadonlyArray<AgentId> }
  | { decision: "Block"; reason?: string };

export type MessageAuthorizeHook = Hook<
  MessageAuthorizeContext,
  MessageAuthorizeResult
>;
