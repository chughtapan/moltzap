import type { ParamsOf } from "@moltzap/protocol/transport";
import type { DispatchAuthorize } from "@moltzap/protocol/dispatch";
import type { MessagesAuthorize } from "@moltzap/protocol/message";
import type { AgentId, UserId } from "@moltzap/protocol/identity";
import type { ConnectionId } from "@moltzap/protocol/socket";
import type { MessageId } from "@moltzap/protocol/conversation";
import type { LeaseId } from "@moltzap/protocol/message";
import type { ContactService } from "../identity/services/contact-policy.js";
import type { ConnectionManager } from "../transport/connection.js";
import type { NetworkSendService } from "../network/network-send.js";
import type { LeaseRegistry } from "../task/leases/lease-registry.js";

export type { UserId, AgentId };

export type ConnectionHook = (params: {
  agentId: AgentId;
  agentName: string;
  /** Owner user ID resolved at agent/connect time. */
  ownerUserId: UserId;
  connId: ConnectionId;
}) => PromiseLike<void> | void;

export type DisconnectionHook = (params: {
  agentId: AgentId;
  ownerUserId: UserId;
  connId: ConnectionId;
}) => PromiseLike<void> | void;

/**
 * Server-side hook context for the `dispatch/authorize` and
 * `messages/authorize` server-to-client RPCs. Context shapes are
 * derived from the protocol's wire schemas via `ParamsOf` — the
 * hook context IS the wire param shape, so a drift between the
 * server-side type and the descriptor is impossible by construction.
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

export interface CoreApp {
  readonly port: number;
  onConnection: (hook: ConnectionHook) => void;

  /**
   * Fires when a WebSocket closes, after auth was established. Use for
   * per-user cleanup (e.g., `last_seen_at` updates). Does not fire for
   * connections that never authenticated.
   */
  onDisconnection: (hook: DisconnectionHook) => void;

  /**
   * Outbound-routing primitive. Apps emit events out-of-band via
   * `networkSendService.send(to, payload)` (directed) or
   * `networkSendService.broadcast(agentIds, payload, opts?)` (fan-out
   * across participants). Stable identity across the server lifetime.
   *
   * The backing `AgentEndpointResolver` is intentionally not exposed —
   * its mutable add/remove surface is server-internal lifecycle, not a
   * CoreApp consumer concern. Tests assert resolver state indirectly
   * via `networkSendService.send` outcomes.
   */
  readonly networkSendService: NetworkSendService;

  /**
   * Live ConnectionManager instance. Apps can query `getByParticipant` to
   * check whether an agent has any live connections (for presence-gated
   * push decisions, etc.). Stable identity.
   */
  readonly connections: ConnectionManager;

  /**
   * Wire a contact-policy gate for app-session admission and
   * conversation-creation paths. The default policy (set by AppHost's
   * constructor) is "allow all" — operators that need real policy
   * decisions inject their resolver here.
   */
  setContactService: (checker: ContactService) => void;

  /**
   * Server-local lease registry for the
   * `dispatch/{request, authorize, release}` admission surface.
   * Stable identity across the server lifetime. Tests + advanced
   * consumers can read lease state directly via this handle.
   */
  readonly leaseRegistry: LeaseRegistry;
  close: () => PromiseLike<void>;
}
