/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import { Effect, Option, Ref } from "effect";

import { PresenceChangedNotificationDefinition } from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { LeaseId } from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";

import type {
  ConnectionManager,
  MoltZapConnection,
} from "../../transport/connection.js";
import {
  type AgentPresenceEntry,
  deriveEntryStatus,
  type DerivedPresenceStatus,
  emitPresenceTransition,
  type LeaseTransitionObserver,
  type PresenceAuditEvent,
} from "./presence-types.js";

const EMPTY_SUBSCRIBERS: ReadonlySet<ConnectionId> = new Set();

type EntryMap = ReadonlyMap<AgentId, AgentPresenceEntry>;

// ── Status-engine pure predicates ───────────────────────────────────

/** Outcome of a lifecycle CAS predicate (connect / disconnect). */
interface LifecycleOutcome {
  readonly prevStatus: DerivedPresenceStatus;
  readonly nextStatus: DerivedPresenceStatus;
}

/** Outcome of a lease-observer CAS predicate (begin / end). */
type ObserverOutcome =
  | { readonly _tag: "audit"; readonly event: PresenceAuditEvent }
  | {
      readonly _tag: "transition";
      readonly prevStatus: DerivedPresenceStatus;
      readonly nextStatus: DerivedPresenceStatus;
    };

interface ObserverCallback {
  readonly kind: "begin" | "end";
  readonly leaseId: LeaseId;
  readonly recipientAgentId: AgentId;
  readonly recipientConnId: ConnectionId;
}

function withNewEntry(
  entries: EntryMap,
  agentId: AgentId,
  entry: AgentPresenceEntry,
): EntryMap {
  const next = new Map(entries);
  next.set(agentId, entry);
  return next;
}

function withoutEntry(entries: EntryMap, agentId: AgentId): EntryMap {
  const next = new Map(entries);
  next.delete(agentId);
  return next;
}

/**
 * Pure predicate for `onAgentConnect`. A second simultaneous WebSocket
 * connection ADDS to `liveConns` rather than replacing it. Status
 * changes only if the agent was previously offline; subsequent
 * additions to an already-tracked agent leave the lease set untouched.
 */
function computeConnectTransition(
  entries: EntryMap,
  agentId: AgentId,
  connId: ConnectionId,
): readonly [LifecycleOutcome, EntryMap] {
  const entry = entries.get(agentId);
  if (entry === undefined) {
    const nextEntry: AgentPresenceEntry = {
      liveConns: new Set([connId]),
      leasesByConn: new Map(),
    };
    return [
      { prevStatus: "offline", nextStatus: "online" },
      withNewEntry(entries, agentId, nextEntry),
    ];
  }
  if (entry.liveConns.has(connId)) {
    const status = deriveEntryStatus(entry);
    return [{ prevStatus: status, nextStatus: status }, entries];
  }
  const status = deriveEntryStatus(entry);
  const nextLiveConns = new Set<ConnectionId>(entry.liveConns);
  nextLiveConns.add(connId);
  const nextEntry: AgentPresenceEntry = {
    liveConns: nextLiveConns,
    leasesByConn: entry.leasesByConn,
  };
  return [
    { prevStatus: status, nextStatus: status },
    withNewEntry(entries, agentId, nextEntry),
  ];
}

/**
 * Pure predicate for `onAgentDisconnect`. Removes `connId` from
 * `liveConns` and drops the per-conn lease bucket so leases bound to
 * the dead conn stop counting toward `working`. If `liveConns` empties
 * out, the entry is removed and status becomes `offline`; otherwise
 * status is re-derived from the leases on the surviving connections.
 * Stale disconnects (the `connId` was never in `liveConns`) are a
 * silent no-op.
 */
function computeDisconnectTransition(
  entries: EntryMap,
  agentId: AgentId,
  connId: ConnectionId,
): readonly [LifecycleOutcome, EntryMap] {
  const entry = entries.get(agentId);
  if (entry === undefined || !entry.liveConns.has(connId)) {
    return [{ prevStatus: "offline", nextStatus: "offline" }, entries];
  }
  const prev = deriveEntryStatus(entry);
  const nextLiveConns = new Set<ConnectionId>(entry.liveConns);
  nextLiveConns.delete(connId);
  if (nextLiveConns.size === 0) {
    return [
      { prevStatus: prev, nextStatus: "offline" },
      withoutEntry(entries, agentId),
    ];
  }
  const nextLeasesByConn = new Map(entry.leasesByConn);
  nextLeasesByConn.delete(connId);
  const nextEntry: AgentPresenceEntry = {
    liveConns: nextLiveConns,
    leasesByConn: nextLeasesByConn,
  };
  const next = deriveEntryStatus(nextEntry);
  return [
    { prevStatus: prev, nextStatus: next },
    withNewEntry(entries, agentId, nextEntry),
  ];
}

function auditAbsentEntry(cb: ObserverCallback): PresenceAuditEvent {
  return cb.kind === "begin"
    ? {
        _tag: "LeaseBeginAfterDisconnect",
        agentId: cb.recipientAgentId,
        leaseId: cb.leaseId,
      }
    : {
        _tag: "LeaseEndAfterDisconnect",
        agentId: cb.recipientAgentId,
        leaseId: cb.leaseId,
      };
}

function auditStaleConnId(
  cb: ObserverCallback,
  currentLiveConns: ReadonlySet<ConnectionId>,
): PresenceAuditEvent {
  // Iteration order is insertion order in ES Map/Set, which gives a
  // stable witness when the agent has multiple live connections.
  const firstLive = currentLiveConns.values().next();
  return {
    _tag: "LeaseCallbackFromStaleConnection",
    agentId: cb.recipientAgentId,
    leaseId: cb.leaseId,
    kind: cb.kind,
    staleConnId: cb.recipientConnId,
    currentConnId: firstLive.done
      ? cb.recipientConnId
      : (firstLive.value as ConnectionId),
  };
}

function applyLeaseToEntry(
  entry: AgentPresenceEntry,
  kind: "begin" | "end",
  leaseId: LeaseId,
  recipientConnId: ConnectionId,
): AgentPresenceEntry {
  const nextLeasesByConn = new Map(entry.leasesByConn);
  const existing = nextLeasesByConn.get(recipientConnId) ?? new Set<LeaseId>();
  const nextLeases = new Set<LeaseId>(existing);
  if (kind === "begin") {
    nextLeases.add(leaseId);
  } else {
    nextLeases.delete(leaseId);
  }
  if (nextLeases.size === 0) {
    nextLeasesByConn.delete(recipientConnId);
  } else {
    nextLeasesByConn.set(recipientConnId, nextLeases);
  }
  return {
    liveConns: entry.liveConns,
    leasesByConn: nextLeasesByConn,
  };
}

/**
 * Pure predicate for lease-observer transitions (begin / end). The
 * `recipientConnId` must be one of the agent's `liveConns`, otherwise
 * the callback is a fast-reconnect-race ghost and audits. The lease is
 * added to / removed from the per-conn bucket
 * `leasesByConn[recipientConnId]`; the agent's derived status is
 * recomputed from the union of leases across ALL live connections.
 */
function computeObserverTransition(
  entries: EntryMap,
  cb: ObserverCallback,
): readonly [ObserverOutcome, EntryMap] {
  const entry = entries.get(cb.recipientAgentId);
  if (entry === undefined) {
    return [{ _tag: "audit", event: auditAbsentEntry(cb) }, entries];
  }
  if (!entry.liveConns.has(cb.recipientConnId)) {
    return [
      { _tag: "audit", event: auditStaleConnId(cb, entry.liveConns) },
      entries,
    ];
  }
  const prev = deriveEntryStatus(entry);
  const nextEntry = applyLeaseToEntry(
    entry,
    cb.kind,
    cb.leaseId,
    cb.recipientConnId,
  );
  const next = deriveEntryStatus(nextEntry);
  return [
    { _tag: "transition", prevStatus: prev, nextStatus: next },
    withNewEntry(entries, cb.recipientAgentId, nextEntry),
  ];
}

function statusForAgent(
  entries: EntryMap,
  agentId: AgentId,
): DerivedPresenceStatus {
  const entry = entries.get(agentId);
  return entry === undefined ? "offline" : deriveEntryStatus(entry);
}

// ── Module-private fan-out sink ─────────────────────────────────────

/**
 * Write one encoded `presence/changed` frame to a single subscriber
 * connection. Fire-and-forget — the wire write runs in a forked fiber
 * so the `Ref.modify` mutator (synchronous, single-CAS) is never
 * blocked on per-subscriber socket latency.
 *
 * A failed `conn.write` is EXPECTED — connection close races with
 * emission, so SocketError is the common case. `Effect.logDebug` keeps
 * the failure observable for triage without raising it to the mutator.
 * `Effect.annotateLogs` carries the connection + transition context
 * once per fork so every log inside the forked fiber inherits it.
 */
function publishOneFrame(
  conn: MoltZapConnection,
  raw: string,
  context: {
    readonly connId: ConnectionId;
    readonly agentId: AgentId;
    readonly status: DerivedPresenceStatus;
  },
): void {
  Effect.runFork(
    conn.write(raw).pipe(
      Effect.catchAll((cause) =>
        Effect.logDebug("presence/changed fan-out write failed").pipe(
          Effect.annotateLogs({ cause }),
        ),
      ),
      Effect.annotateLogs(context),
    ),
  );
}

/**
 * Send a `presence/changed` notification to every subscriber
 * connection. The subscriber set is snapshotted by the caller before
 * this runs, so concurrent `subscribe` / `removeConnection` mutations
 * cannot leak into the fan-out.
 */
function fanOut(
  connections: ConnectionManager,
  agentId: AgentId,
  status: DerivedPresenceStatus,
  subscriberConnIds: ReadonlySet<ConnectionId>,
): void {
  if (subscriberConnIds.size === 0) return;
  const raw = JSON.stringify(
    PresenceChangedNotificationDefinition.encode({ agentId, status }),
  );
  for (const connId of subscriberConnIds) {
    const conn = connections.get(connId);
    if (conn !== undefined) {
      publishOneFrame(conn, raw, { connId, agentId, status });
    }
  }
}

/**
 * Presence service: subscriber registry + lease-derived status engine
 * + `presence/changed` fan-out.
 *
 * Implements {@link LeaseTransitionObserver} so the {@link LeaseRegistry}
 * can drive lease transitions through it — the registry depends on the
 * narrow observer contract, not on this whole surface. The WS-lifecycle
 * hooks (`onAgentConnect` / `onAgentDisconnect`) feed connection
 * transitions, and `presence/subscribe` reads status via `statusMany`
 * and registers fan-out interest via `subscribe`.
 *
 * **State.** Two in-memory stores, both lost on restart (agents
 * repopulate on reconnect):
 *
 * - subscriber registry — `subscribers: agentId → Set<connId>` (which
 *   connections want fan-out for which agent) plus the reverse
 *   `connSubscriptions: connId → Set<agentId>` so `subscribe` can
 *   replace a connection's watch set without scanning every agent.
 * - status map — `Ref<ReadonlyMap<AgentId, AgentPresenceEntry>>`. Each
 *   entry carries `liveConns` (every WS conn the agent is authed on) +
 *   `leasesByConn` (per-conn active-lease buckets). Multi-connection
 *   shaped: a second simultaneous connect ADDS to `liveConns` rather
 *   than clobbering it.
 *
 * **One `Ref.modify` per transition, linearizing both state AND
 * emission decision.** Every observer/lifecycle method computes its
 * result inside a single `Ref.modify` predicate, then publishes the
 * dedup-gated emission AFTER the CAS commits. The dedup rule
 * ({@link emitPresenceTransition}) NAMES the previous status at the
 * emission site, so concurrent GRANTED leases elide duplicate
 * `working` notifications.
 *
 * **Entry-creation invariant (load-bearing).** Entries are created
 * EXCLUSIVELY in `onAgentConnect` (first connection). Subsequent
 * connects add to `liveConns`; the entry is never re-created while any
 * conn survives. A lease callback on an unknown agent NEVER allocates
 * an entry; instead it audits ({@link PresenceAuditEvent}) and no-ops.
 * Combined with the `recipientConnId ∈ liveConns` check, every full
 * disconnect (last conn) produces exactly one `offline` emission, and
 * stale lease callbacks across reconnect / partial-disconnect
 * boundaries neither mutate state nor emit.
 *
 * Emission flow (lease-observer path; the lifecycle path is the same
 * dispatch minus the audit arms):
 *
 * ```mermaid
 * sequenceDiagram
 *   participant LR as LeaseRegistry
 *   participant PS as PresenceService
 *   participant Subs as Subscribers (WS clients)
 *
 *   LR->>PS: onLeaseActiveBegin(leaseId, agentId, recipientConnId)
 *   PS->>PS: Ref.modify computes BOTH new entry AND emission decision in one CAS
 *   alt agent has entry AND recipientConnId ∈ entry.liveConns
 *     PS->>PS: prev = deriveEntryStatus(entry)<br>leasesByConn[recipientConnId] ∪= {leaseId}<br>next = any bucket non-empty ? "working" : "online"
 *     PS->>PS: emitPresenceTransition(prev, next) — dedup
 *     alt decision = some(status)
 *       PS->>PS: snapshot = new Set(getSubscribers(agentId))
 *       PS->>Subs: presence/changed { agentId, status }
 *     else decision = none
 *       Note over PS: dedup — concurrent GRANTED, no fan-out
 *     end
 *   else entry exists but recipientConnId ∉ liveConns (fast-reconnect race)
 *     Note over PS: audit LeaseCallbackFromStaleConnection — Effect.logDebug, no emission
 *   else agent has no entry (disconnected)
 *     Note over PS: audit LeaseBeginAfterDisconnect — Effect.logDebug, no emission
 *   end
 * ```
 */
export class PresenceService implements LeaseTransitionObserver {
  private subscribers = new Map<string, Set<ConnectionId>>();
  // Per-connection record of which agentIds the connection is
  // subscribed to. Tracked so `subscribe()` can replace the prior
  // subscription set atomically without scanning every agent's
  // subscriber set.
  private connSubscriptions = new Map<ConnectionId, Set<string>>();

  private constructor(
    private readonly connections: ConnectionManager,
    private readonly entries: Ref.Ref<EntryMap>,
  ) {}

  /**
   * Construct the service. One instance per server lifetime; wired into
   * `LeaseRegistryDeps.transitionObserver` at composition root.
   * `connections` is the {@link ConnectionManager} the fan-out reads to
   * resolve each subscriber's socket.
   */
  static make(
    connections: ConnectionManager,
  ): Effect.Effect<PresenceService, never, never> {
    return Effect.gen(function* () {
      const entries = yield* Ref.make<EntryMap>(new Map());
      return new PresenceService(connections, entries);
    }).pipe(Effect.withSpan("PresenceService.make"));
  }

  // ── Subscriber registry ───────────────────────────────────────────

  /**
   * Replace the connection's subscriber set with `agentIds`.
   *
   * Replace-semantics: after this call, `connId` appears in the
   * subscriber set for EXACTLY the agents in `agentIds`, and ONLY
   * those. Any agent `connId` was previously subscribed to but absent
   * from `agentIds` has `connId` removed from its subscriber set. Pass
   * an empty array to unsubscribe from all. Long-running clients that
   * re-evaluate their watch set per iteration can call this
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

  // ── Status engine ─────────────────────────────────────────────────

  /**
   * Snapshot the live subscriber set BEFORE fan-out iterates, then
   * publish iff the dedup decision is `Some`. The two-arg dedup
   * (`emitPresenceTransition`) is the sole gate; this is the only path
   * from in-memory state to wire publish.
   */
  private emit(
    previous: DerivedPresenceStatus,
    next: DerivedPresenceStatus,
    agentId: AgentId,
  ): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      const decision = emitPresenceTransition(previous, next);
      if (Option.isNone(decision)) return;
      const subscriberConnIds = new Set(this.getSubscribers(agentId));
      fanOut(this.connections, agentId, decision.value, subscriberConnIds);
    });
  }

  /**
   * WS connect: add `connId` to the agent's `liveConns` and emit
   * `online` on first connection. A second simultaneous connect ADDS to
   * the set rather than replacing it; the dedup rule elides the
   * redundant emission. Public error channel is `never` — runs inside
   * the connect handler and MUST NOT block on emission failure.
   */
  onAgentConnect(
    agentId: AgentId,
    connId: ConnectionId,
  ): Effect.Effect<void, never, never> {
    return Ref.modify(this.entries, (entries) =>
      computeConnectTransition(entries, agentId, connId),
    ).pipe(
      Effect.flatMap((o) => this.emit(o.prevStatus, o.nextStatus, agentId)),
    );
  }

  /**
   * WS disconnect: remove `connId` from the agent's `liveConns` and
   * drop its `leasesByConn[connId]` bucket. Called BEFORE
   * `LeaseRegistry.abandon(connId)` from the WS-close finalizer, so the
   * subsequent abandon's `onLeaseActiveEnd` callbacks find `connId`
   * absent from `liveConns` and audit (no emission). Emits `offline`
   * only when `liveConns` empties out, else re-derives from the
   * surviving conns' lease buckets. Public error channel is `never`.
   */
  onAgentDisconnect(
    agentId: AgentId,
    connId: ConnectionId,
  ): Effect.Effect<void, never, never> {
    return Ref.modify(this.entries, (entries) =>
      computeDisconnectTransition(entries, agentId, connId),
    ).pipe(
      Effect.flatMap((o) => this.emit(o.prevStatus, o.nextStatus, agentId)),
    );
  }

  onLeaseActiveBegin(
    leaseId: LeaseId,
    recipientAgentId: AgentId,
    recipientConnId: ConnectionId,
  ): Effect.Effect<void, never, never> {
    return this.handleObserverTransition({
      kind: "begin",
      leaseId,
      recipientAgentId,
      recipientConnId,
    });
  }

  onLeaseActiveEnd(
    leaseId: LeaseId,
    recipientAgentId: AgentId,
    recipientConnId: ConnectionId,
  ): Effect.Effect<void, never, never> {
    return this.handleObserverTransition({
      kind: "end",
      leaseId,
      recipientAgentId,
      recipientConnId,
    });
  }

  private handleObserverTransition(
    cb: ObserverCallback,
  ): Effect.Effect<void, never, never> {
    return Ref.modify(this.entries, (entries) =>
      computeObserverTransition(entries, cb),
    ).pipe(
      Effect.flatMap((outcome) =>
        outcome._tag === "audit"
          ? Effect.logDebug("presence audit", outcome.event)
          : this.emit(
              outcome.prevStatus,
              outcome.nextStatus,
              cb.recipientAgentId,
            ),
      ),
    );
  }

  /**
   * Read the agent's current status. Returns `"offline"` for an unknown
   * agent. Each call reads the `Ref` once; the result is a
   * point-in-time snapshot.
   */
  statusOf(
    agentId: AgentId,
  ): Effect.Effect<DerivedPresenceStatus, never, never> {
    return Ref.get(this.entries).pipe(
      Effect.map((entries) => statusForAgent(entries, agentId)),
    );
  }

  /**
   * Bulk read for the `presence/subscribe` handler. Returns one entry
   * per requested `agentId` in input order; unknown agents resolve to
   * `"offline"`. One `Ref.get` at the start of the call; all entries
   * are read from the same snapshot.
   */
  statusMany(agentIds: ReadonlyArray<AgentId>): Effect.Effect<
    ReadonlyArray<{
      readonly agentId: AgentId;
      readonly status: DerivedPresenceStatus;
    }>,
    never,
    never
  > {
    return Ref.get(this.entries).pipe(
      Effect.map((entries) =>
        agentIds.map((agentId) => ({
          agentId,
          status: statusForAgent(entries, agentId),
        })),
      ),
    );
  }
}
