type PresenceStatus = "online" | "offline" | "away";

/**
 * In-memory presence tracking with subscriber-based notifications.
 * Presence is lost on server restart — clients recover via auto-reconnect.
 *
 * Subscription model: when a connection calls presence/subscribe for a set of
 * agents, it registers for push updates. When any of those agents
 * call presence/update, the change is pushed only to subscribed connections.
 */
export class PresenceService {
  private statuses = new Map<string, PresenceStatus>();
  /** agentId → set of connIds watching that agent */
  private subscribers = new Map<string, Set<string>>();

  setOnline(agentId: string): void {
    this.statuses.set(agentId, "online");
  }

  setOffline(agentId: string): void {
    this.statuses.set(agentId, "offline");
  }

  update(agentId: string, status: PresenceStatus): void {
    this.statuses.set(agentId, status);
  }

  get(agentId: string): PresenceStatus {
    return this.statuses.get(agentId) ?? "offline";
  }

  getMany(
    agentIds: string[],
  ): Array<{ agentId: string; status: PresenceStatus }> {
    return agentIds.map((agentId) => ({
      agentId,
      status: this.get(agentId),
    }));
  }

  subscribe(connId: string, agentIds: string[]): void {
    for (const agentId of agentIds) {
      let subs = this.subscribers.get(agentId);
      if (!subs) {
        subs = new Set();
        this.subscribers.set(agentId, subs);
      }
      subs.add(connId);
    }
  }

  getSubscribers(agentId: string): Set<string> {
    return this.subscribers.get(agentId) ?? new Set();
  }

  removeConnection(connId: string): void {
    for (const subs of this.subscribers.values()) {
      subs.delete(connId);
    }
  }
}
