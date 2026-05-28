import type { ConnectionId } from "@moltzap/protocol/network";

const EMPTY_SUBSCRIBERS: ReadonlySet<ConnectionId> = new Set();

/**
 * In-memory subscriber registry for `presence/subscribe` fan-out.
 *
 * **Architect plan #706 v7 (codex r6 P2 #2) — narrowed surface.**
 * Pre-v7 this class also held the per-agent presence-status map and
 * the mutation methods (`setOnline` / `setOffline` / `update` /
 * `get` / `getMany`). Those moved into `PresenceProjection` (status
 * derivation) + `_internal/presence-emit.ts` (sink fan-out). v7
 * deletes the mutation + read surface from this class entirely;
 * what remains is the subscriber registry (which conn ids care about
 * which agent id) — the projection consumes it via the
 * `PresenceSubscriberRegistry` interface for fan-out snapshots.
 *
 * Surviving surface: `subscribe / removeConnection / getSubscribers`.
 *
 * Constructor takes no deps (v7) — the `PresenceEventSink`
 * constructor parameter was deleted along with the mutation methods
 * that called it. The architect plan's structural seal (three
 * `@ts-expect-error` canaries at
 * `_internal/presence-emit.ts`) keeps sink construction outside this
 * class.
 */
export class PresenceService {
  private subscribers = new Map<string, Set<ConnectionId>>();
  // Per-connection record of which agentIds the connection is subscribed
  // to. Tracked so `subscribe()` can replace the prior subscription set
  // atomically without scanning every agent's subscriber set.
  private connSubscriptions = new Map<ConnectionId, Set<string>>();

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
  subscribe(connId: ConnectionId, agentIds: ReadonlyArray<string>): void {
    const next = new Set(agentIds);
    const prev = this.connSubscriptions.get(connId);
    this.removeStaleSubscriptions(connId, next, prev);
    this.addSubscriptions(connId, next);
    this.rememberSubscriptionSet(connId, next);
  }

  private removeStaleSubscriptions(
    connId: ConnectionId,
    next: ReadonlySet<string>,
    prev: ReadonlySet<string> | undefined,
  ): void {
    if (prev) {
      for (const agentId of prev) {
        if (!next.has(agentId)) {
          this.subscribers.get(agentId)?.delete(connId);
        }
      }
    }
  }

  private addSubscriptions(
    connId: ConnectionId,
    next: ReadonlySet<string>,
  ): void {
    for (const agentId of next) {
      let subs = this.subscribers.get(agentId);
      if (!subs) {
        subs = new Set();
        this.subscribers.set(agentId, subs);
      }
      subs.add(connId);
    }
  }

  private rememberSubscriptionSet(
    connId: ConnectionId,
    next: ReadonlySet<string>,
  ): void {
    if (next.size === 0) {
      this.connSubscriptions.delete(connId);
    } else {
      this.connSubscriptions.set(connId, new Set(next));
    }
  }

  getSubscribers(agentId: string): ReadonlySet<ConnectionId> {
    return this.subscribers.get(agentId) ?? EMPTY_SUBSCRIBERS;
  }

  removeConnection(connId: ConnectionId): void {
    for (const subs of this.subscribers.values()) {
      subs.delete(connId);
    }
    this.connSubscriptions.delete(connId);
  }
}
