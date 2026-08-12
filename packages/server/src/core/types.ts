import type { ConnectionManager } from "#socket";
import type { NetworkSendService } from "#network";

/** Describes core app. */
export interface CoreApp {
  readonly port: number;

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
