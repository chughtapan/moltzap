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

  getMany(
    agentIds: ReadonlyArray<string>,
  ): Array<{ agentId: string; status: PresenceStatus }> {
    return agentIds.map((agentId) => ({
      agentId,
      status: this.get(agentId),
    }));
  }

  subscribe(connId: string, agentIds: ReadonlyArray<string>): void {
    for (const agentId of agentIds) {
      let subs = this.subscribers.get(agentId);
      if (!subs) {
        subs = new Set();
        this.subscribers.set(agentId, subs);
      }
      subs.add(connId);
    }
  }

  getSubscribers(agentId: string): ReadonlySet<string> {
    return this.subscribers.get(agentId) ?? EMPTY_SUBSCRIBERS;
  }

  removeConnection(connId: string): void {
    for (const subs of this.subscribers.values()) {
      subs.delete(connId);
    }
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
