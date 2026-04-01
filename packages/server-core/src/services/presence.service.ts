import type { ParticipantRef } from "@moltzap/protocol";

type PresenceStatus = "online" | "offline" | "away";

/**
 * In-memory presence tracking with subscriber-based notifications.
 * Presence is lost on server restart — clients recover via auto-reconnect.
 *
 * Subscription model: when a connection calls presence/subscribe for a set of
 * participants, it registers for push updates. When any of those participants
 * call presence/update, the change is pushed only to subscribed connections.
 */
export class PresenceService {
  private statuses = new Map<string, PresenceStatus>();
  /** participantKey → set of connIds watching that participant */
  private subscribers = new Map<string, Set<string>>();

  private key(ref: ParticipantRef): string {
    return `${ref.type}:${ref.id}`;
  }

  setOnline(ref: ParticipantRef): void {
    this.statuses.set(this.key(ref), "online");
  }

  setOffline(ref: ParticipantRef): void {
    this.statuses.set(this.key(ref), "offline");
  }

  update(ref: ParticipantRef, status: PresenceStatus): void {
    this.statuses.set(this.key(ref), status);
  }

  get(ref: ParticipantRef): PresenceStatus {
    return this.statuses.get(this.key(ref)) ?? "offline";
  }

  getMany(
    refs: ParticipantRef[],
  ): Array<{ participant: ParticipantRef; status: PresenceStatus }> {
    return refs.map((ref) => ({
      participant: ref,
      status: this.get(ref),
    }));
  }

  subscribe(connId: string, participants: ParticipantRef[]): void {
    for (const ref of participants) {
      const k = this.key(ref);
      let subs = this.subscribers.get(k);
      if (!subs) {
        subs = new Set();
        this.subscribers.set(k, subs);
      }
      subs.add(connId);
    }
  }

  getSubscribers(ref: ParticipantRef): Set<string> {
    return this.subscribers.get(this.key(ref)) ?? new Set();
  }

  removeConnection(connId: string): void {
    for (const subs of this.subscribers.values()) {
      subs.delete(connId);
    }
  }
}
