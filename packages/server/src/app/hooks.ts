/**
 * @file Server-side hook types for the `dispatch/authorize` and
 * `messages/authorize` server-to-client RPCs. Context shapes are
 * derived from the protocol's wire schemas (`ParamsOf`); the
 * `signal: AbortSignal` reaches handlers via the runner that invokes
 * them (`AppHost.runInProcessHookEffect`), not via the wire context.
 */

import {
  type ParamsOf,
  type DispatchAuthorize,
  type MessagesAuthorize,
} from "@moltzap/protocol";
import type { LeaseId, MessageId } from "@moltzap/protocol/task";
import type { AgentId } from "@moltzap/protocol/identity";

export type TaskAuthorizeDispatchContext = ParamsOf<typeof DispatchAuthorize>;

export type DispatchAdmissionResult =
  | {
      decision: "grant";
      leaseId?: LeaseId;
      leaseTimeoutMs?: number;
      dispatchMessageId?: MessageId;
    }
  | { decision: "deny"; reason?: string }
  | { decision: "hold"; reason?: string };

export type TaskAuthorizeDispatchHook = (
  ctx: TaskAuthorizeDispatchContext & { signal: AbortSignal },
) => DispatchAdmissionResult | Promise<DispatchAdmissionResult>;

export type MessageAuthorizeContext = ParamsOf<typeof MessagesAuthorize>;

export type MessageAuthorizeResult =
  | { decision: "Forward"; recipients: ReadonlyArray<AgentId> }
  | { decision: "Block"; reason?: string };

export type MessageAuthorizeHook = (
  ctx: MessageAuthorizeContext & { signal: AbortSignal },
) => MessageAuthorizeResult | Promise<MessageAuthorizeResult>;
