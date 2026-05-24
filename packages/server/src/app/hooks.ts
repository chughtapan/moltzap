/**
 * @file Server-side hook types for the `dispatch/authorize` and
 * `messages/authorize` server-to-client RPCs. Context shapes are
 * derived from the protocol's wire schemas via `ParamsOf` — the
 * hook context IS the wire param shape, so a drift between the
 * server-side type and the descriptor is impossible by construction.
 */
import type {
  ParamsOf,
  DispatchAuthorize,
  MessagesAuthorize,
} from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { LeaseId, MessageId } from "@moltzap/protocol/task";

/**
 * Server-side dispatch admission hook context. Equals the
 * `dispatch/authorize` wire param shape.
 */
export type DispatchAuthorizeContext = ParamsOf<typeof DispatchAuthorize>;

export type DispatchAdmissionResult =
  | {
      decision: "grant";
      leaseId?: LeaseId;
      leaseTimeoutMs?: number;
      dispatchMessageId?: MessageId;
    }
  | { decision: "deny"; reason?: string }
  | { decision: "hold"; reason?: string };

/**
 * Server-side message-fan-out authorization hook context. Equals the
 * `messages/authorize` wire param shape. Symmetric to
 * `DispatchAuthorizeContext` — same fail-closed posture, different
 * verdict union.
 */
export type MessageAuthorizeContext = ParamsOf<typeof MessagesAuthorize>;

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
