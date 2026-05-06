import type {
  PresenceEventSink,
  PresenceStatus,
} from "./presence-event-sink.js";

const EMPTY_SUBSCRIBERS: ReadonlySet<string> = new Set();

/**
 * In-memory presence state + subscriber registry. Every mutating call
 * (setOnline / setOffline / update) flows through `transition`, which
 * publishes via the sink iff the status changed.
 *
 * Out of scope: multi-connection-per-agent and concurrent close-vs-connect
 * race semantics. The `prior !== next` guard is correct for the
 * single-connection-per-agent case; tracked separately.
 */
export class PresenceService {
  private statuses = new Map<string, PresenceStatus>();
  private subscribers = new Map<string, Set<string>>();
  // Per-connection record of which agentIds the connection is subscribed
  // to. Tracked so `subscribe()` can replace the prior subscription set
  // atomically without scanning every agent's subscriber set.
  private connSubscriptions = new Map<string, Set<string>>();

  constructor(private readonly eventSink: PresenceEventSink) {}

  setOnline(agentId: string): void {
    this.transition(agentId, "online");
  }

  setOffline(agentId: string): void {
    this.transition(agentId, "offline");
  }

  update(
    agentId: string,
    status: PresenceStatus,
    options: { readonly excludeConnId?: string } = {},
  ): void {
    this.transition(agentId, status, options.excludeConnId);
  }

  get(agentId: string): PresenceStatus {
    return this.statuses.get(agentId) ?? "offline";
  }

  getMany<AgentIdValue extends string>(
    agentIds: ReadonlyArray<AgentIdValue>,
  ): Array<{ agentId: AgentIdValue; status: PresenceStatus }> {
    return agentIds.map((agentId) => ({
      agentId,
      status: this.get(agentId),
    }));
  }

  /**
   * Replace the connection's subscriber set with `agentIds`.
   *
   * Replace-semantics: after this call, `connId` appears in the subscriber
   * set for EXACTLY the agents in `agentIds`, and ONLY those. Any agent
   * `connId` was previously subscribed to but absent from `agentIds` has
   * `connId` removed from its subscriber set. Pass an empty array to
   * unsubscribe from all (functionally an unsubscribe-all). Long-running
   * clients that re-evaluate their watch set per iteration can call this
   * idempotently without leaking fan-out across the union of past sets.
   */
  subscribe(connId: string, agentIds: ReadonlyArray<string>): void {
    const next = new Set(agentIds);
    const prev = this.connSubscriptions.get(connId);

    // Remove connId from agents the connection no longer watches.
    if (prev) {
      for (const agentId of prev) {
        if (!next.has(agentId)) {
          this.subscribers.get(agentId)?.delete(connId);
        }
      }
    }

    // Add connId to agents in the new set (idempotent if already present).
    for (const agentId of next) {
      let subs = this.subscribers.get(agentId);
      if (!subs) {
        subs = new Set();
        this.subscribers.set(agentId, subs);
      }
      subs.add(connId);
    }

    if (next.size === 0) {
      this.connSubscriptions.delete(connId);
    } else {
      this.connSubscriptions.set(connId, next);
    }
  }

  getSubscribers(agentId: string): ReadonlySet<string> {
    return this.subscribers.get(agentId) ?? EMPTY_SUBSCRIBERS;
  }

  removeConnection(connId: string): void {
    for (const subs of this.subscribers.values()) {
      subs.delete(connId);
    }
    this.connSubscriptions.delete(connId);
  }

  private transition(
    agentId: string,
    next: PresenceStatus,
    excludeConnId?: string,
  ): void {
    const prev = this.statuses.get(agentId) ?? "offline";
    if (prev === next) return;
    this.statuses.set(agentId, next);
    // Snapshot — caller may inspect the input after publish returns
    // (deferred sinks, tests that capture inputs for later assertion).
    // Live registry mutations must not alter past inputs.
    this.eventSink.publish({
      agentId,
      status: next,
      subscriberConnIds: new Set(this.getSubscribers(agentId)),
      excludeConnId,
    });
  }
}
