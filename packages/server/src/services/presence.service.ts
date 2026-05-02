import { Effect } from "effect";

import { EventNames, eventFrame } from "@moltzap/protocol";

import type { ConnectionManager } from "../ws/connection.js";

type PresenceStatus = "online" | "offline" | "away";

/**
 * In-memory presence tracking with subscriber-based notifications.
 * Presence is lost on server restart — clients recover via auto-reconnect.
 *
 * Subscription model: when a connection calls presence/subscribe for a set of
 * agents, it registers for push updates. Every mutating call site
 * (connect → setOnline, disconnect → setOffline, RPC → update) flows through
 * `transition`, which publishes `presence/changed` to subscribers iff the
 * status actually changed.
 *
 * Multi-connection-per-agent caveat: `setOffline` is unconditional on the
 * disconnecting connection. If an agent holds multiple sockets and one
 * drops while the others remain, this still broadcasts `offline`. The
 * arena fleet pattern (one socket per agentId) does not exercise that
 * shape; tracked separately for general moltzap consumers.
 */
export class PresenceService {
  private statuses = new Map<string, PresenceStatus>();
  /** agentId → set of connIds watching that agent */
  private subscribers = new Map<string, Set<string>>();

  constructor(private readonly connections: ConnectionManager) {}

  setOnline(agentId: string): void {
    this.transition(agentId, "online");
  }

  setOffline(agentId: string): void {
    this.transition(agentId, "offline");
  }

  /** `senderConnId` is the connection that issued the RPC and is excluded
   * from the broadcast (it already knows the new status). */
  update(agentId: string, status: PresenceStatus, senderConnId?: string): void {
    this.transition(agentId, status, senderConnId);
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

  private transition(
    agentId: string,
    next: PresenceStatus,
    exceptConnId?: string,
  ): void {
    const prev = this.statuses.get(agentId) ?? "offline";
    if (prev === next) return;
    this.statuses.set(agentId, next);
    this.broadcast(agentId, next, exceptConnId);
  }

  private broadcast(
    agentId: string,
    status: PresenceStatus,
    exceptConnId?: string,
  ): void {
    const subs = this.subscribers.get(agentId);
    if (!subs || subs.size === 0) return;
    const raw = JSON.stringify(
      eventFrame(EventNames.PresenceChanged, { agentId, status }),
    );
    for (const connId of subs) {
      if (connId === exceptConnId) continue;
      const conn = this.connections.get(connId);
      if (!conn) continue;
      Effect.runFork(conn.write(raw).pipe(Effect.catchAll(() => Effect.void)));
    }
  }
}
