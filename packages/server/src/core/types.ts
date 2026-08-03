import type { AgentId, UserId } from "@moltzap/protocol/identity";
import type { ConnectionId } from "@moltzap/protocol/socket";
import type { ConnectionManager } from "#socket";
import type { NetworkSendService } from "#network";

/** Represents connection hook values. */
export type ConnectionHook = (params: {
  agentId: AgentId;
  agentName: string;
  /** Owner user ID resolved at agent/network/connect time. */
  ownerUserId: UserId;
  connId: ConnectionId;
}) => PromiseLike<undefined> | undefined;

/** Represents disconnection hook values. */
export type DisconnectionHook = (params: {
  agentId: AgentId;
  ownerUserId: UserId;
  connId: ConnectionId;
}) => PromiseLike<undefined> | undefined;

/** Describes core app. */
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
   * check whether an agent has any live connections (for liveness-gated
   * push decisions, etc.). Stable identity.
   */
  readonly connections: ConnectionManager;
  close: () => PromiseLike<undefined>;
}
