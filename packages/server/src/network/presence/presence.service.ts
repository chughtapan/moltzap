import { Effect, Ref } from "effect";

import type { AgentId } from "@moltzap/protocol/identity";
import type { LeaseId } from "@moltzap/protocol/message/dispatch";
import type { ConnectionId } from "@moltzap/protocol/socket";

import {
  type AgentPresenceEntry,
  deriveEntryStatus,
  type DerivedPresenceStatus,
  type LeaseTransitionObserver,
  type PresenceAuditEvent,
} from "./presence-types.js";

type EntryMap = ReadonlyMap<AgentId, AgentPresenceEntry>;

// ── Status-engine pure predicates ───────────────────────────────────

/** Outcome of a lease-observer CAS predicate (begin / end). */
type ObserverOutcome =
  | { readonly _tag: "audit"; readonly event: PresenceAuditEvent }
  | { readonly _tag: "updated" };

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
 * @param entries Value supplied to the operation.
 * @param agentId Identifier of the agent targeted by the operation.
 * @param connId Value supplied to the operation.
 * @returns The compute connect transition result.
 */
function computeConnectTransition(
  entries: EntryMap,
  agentId: AgentId,
  connId: ConnectionId,
): EntryMap {
  const entry = entries.get(agentId);
  if (entry === undefined) {
    const nextEntry: AgentPresenceEntry = {
      liveConns: new Set([connId]),
      leasesByConn: new Map(),
    };
    return withNewEntry(entries, agentId, nextEntry);
  }
  if (entry.liveConns.has(connId)) {
    return entries;
  }
  const nextLiveConns = new Set<ConnectionId>(entry.liveConns);
  nextLiveConns.add(connId);
  const nextEntry: AgentPresenceEntry = {
    liveConns: nextLiveConns,
    leasesByConn: entry.leasesByConn,
  };
  return withNewEntry(entries, agentId, nextEntry);
}

/**
 * Pure predicate for `onAgentDisconnect`. Removes `connId` from
 * `liveConns` and drops the per-conn lease bucket so leases bound to
 * the dead conn stop counting toward `working`. If `liveConns` empties
 * out, the entry is removed and status becomes `offline`; otherwise
 * status is re-derived from the leases on the surviving connections.
 * Stale disconnects (the `connId` was never in `liveConns`) are a
 * silent no-op.
 * @param entries Value supplied to the operation.
 * @param agentId Identifier of the agent targeted by the operation.
 * @param connId Value supplied to the operation.
 * @returns The compute disconnect transition result.
 */
function computeDisconnectTransition(
  entries: EntryMap,
  agentId: AgentId,
  connId: ConnectionId,
): EntryMap {
  const entry = entries.get(agentId);
  if (entry === undefined || !entry.liveConns.has(connId)) {
    return entries;
  }
  const nextLiveConns = new Set<ConnectionId>(entry.liveConns);
  nextLiveConns.delete(connId);
  if (nextLiveConns.size === 0) {
    return withoutEntry(entries, agentId);
  }
  const nextLeasesByConn = new Map(entry.leasesByConn);
  nextLeasesByConn.delete(connId);
  const nextEntry: AgentPresenceEntry = {
    liveConns: nextLiveConns,
    leasesByConn: nextLeasesByConn,
  };
  return withNewEntry(entries, agentId, nextEntry);
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
    currentConnId: firstLive.done ? cb.recipientConnId : firstLive.value,
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
 * @param entries Value supplied to the operation.
 * @param cb Value supplied to the operation.
 * @returns The compute observer transition result.
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
  const nextEntry = applyLeaseToEntry(
    entry,
    cb.kind,
    cb.leaseId,
    cb.recipientConnId,
  );
  return [
    { _tag: "updated" },
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

/**
 * Presence service: lease-derived status engine.
 *
 * Implements {@link LeaseTransitionObserver} so the `LeaseRegistry`
 * can drive lease transitions through it — the registry depends on the
 * narrow observer contract, not on this whole surface. The WS-lifecycle
 * hooks (`onAgentConnect` / `onAgentDisconnect`) feed connection
 * transitions, and `network/presence/subscribe` reads status via `statusMany`.
 *
 * **State.** One in-memory status map, lost on restart. Agents repopulate
 * it on reconnect. Each entry carries `liveConns` (every WS conn the agent
 * is authed on) + `leasesByConn` (per-conn active-lease buckets).
 * Multi-connection shaped: a second simultaneous connect ADDS to
 * `liveConns` rather than clobbering it.
 *
 * **One Ref update per transition.** Every observer/lifecycle method
 * computes its result inside one Ref operation so status updates remain
 * linearized across connect, disconnect, and lease callbacks.
 *
 * **Entry-creation invariant (load-bearing).** Entries are created
 * EXCLUSIVELY in `onAgentConnect` (first connection). Subsequent
 * connects add to `liveConns`; the entry is never re-created while any
 * conn survives. A lease callback on an unknown agent NEVER allocates
 * an entry; instead it audits ({@link PresenceAuditEvent}) and no-ops.
 * Combined with the `recipientConnId ∈ liveConns` check, stale lease
 * callbacks across reconnect / partial-disconnect boundaries neither mutate
 * state nor re-create disconnected agents.
 *
 * Lease observer flow:.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant LR as LeaseRegistry
 *   participant PS as PresenceService
 *   LR->>PS: onLeaseActiveBegin(leaseId, agentId, recipientConnId)
 *   PS->>PS: Ref.modify computes the updated entry in one CAS
 *   alt agent has entry AND recipientConnId ∈ entry.liveConns
 *     PS->>PS: leasesByConn[recipientConnId] ∪= {leaseId} — status derives from the updated entry
 *   else entry exists but recipientConnId ∉ liveConns (fast-reconnect race)
 *     Note over PS: audit LeaseCallbackFromStaleConnection — Effect.logDebug
 *   else agent has no entry (disconnected)
 *     Note over PS: audit LeaseBeginAfterDisconnect — Effect.logDebug
 *   end
 * ```
 */
export class PresenceService implements LeaseTransitionObserver {
  private readonly entries: Ref.Ref<EntryMap>;

  private constructor(entries: Ref.Ref<EntryMap>) {
    this.entries = entries;
  }

  /**
   * Construct the service. One instance per server lifetime; wired into
   * `LeaseRegistryDeps.transitionObserver` at composition root.
   * @returns The entries result.
   */
  static make(): Effect.Effect<PresenceService> {
    return Effect.gen(function* () {
      const entries = yield* Ref.make<EntryMap>(new Map());
      return new PresenceService(entries);
    }).pipe(Effect.withSpan("PresenceService.make"));
  }

  // ── Status engine ─────────────────────────────────────────────────

  /**
   * WS connect: add `connId` to the agent's `liveConns`. A second
   * simultaneous connect ADDS to the set rather than replacing it.
   * Public error channel is `never` — runs inside the connect handler.
   * @param agentId Identifier of the agent targeted by the operation.
   * @param connId Value supplied to the operation.
   * @returns The on agent connect result.
   */
  onAgentConnect(agentId: AgentId, connId: ConnectionId): Effect.Effect<void> {
    return Ref.update(this.entries, (entries) =>
      computeConnectTransition(entries, agentId, connId),
    );
  }

  /**
   * WS disconnect: remove `connId` from the agent's `liveConns` and
   * drop its `leasesByConn[connId]` bucket. Called BEFORE
   * `LeaseRegistry.abandon(connId)` from the WS-close finalizer, so the
   * subsequent abandon's `onLeaseActiveEnd` callbacks find `connId`
   * absent from `liveConns` and audit. Public error channel is `never`.
   * @param agentId Identifier of the agent targeted by the operation.
   * @param connId Value supplied to the operation.
   * @returns The on agent disconnect result.
   */
  onAgentDisconnect(
    agentId: AgentId,
    connId: ConnectionId,
  ): Effect.Effect<void> {
    return Ref.update(this.entries, (entries) =>
      computeDisconnectTransition(entries, agentId, connId),
    );
  }

  onLeaseActiveBegin(
    leaseId: LeaseId,
    recipientAgentId: AgentId,
    recipientConnId: ConnectionId,
  ): Effect.Effect<void> {
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
  ): Effect.Effect<void> {
    return this.handleObserverTransition({
      kind: "end",
      leaseId,
      recipientAgentId,
      recipientConnId,
    });
  }

  private handleObserverTransition(cb: ObserverCallback): Effect.Effect<void> {
    return Ref.modify(this.entries, (entries) =>
      computeObserverTransition(entries, cb),
    ).pipe(
      Effect.flatMap((outcome) =>
        outcome._tag === "audit"
          ? Effect.logDebug("presence audit", outcome.event)
          : Effect.void,
      ),
    );
  }

  /**
   * Read the agent's current status. Returns `"offline"` for an unknown
   * agent. Each call reads the `Ref` once; the result is a
   * point-in-time snapshot.
   * @param agentId Identifier of the agent targeted by the operation.
   * @returns The status of result.
   */
  statusOf(agentId: AgentId): Effect.Effect<DerivedPresenceStatus> {
    return Ref.get(this.entries).pipe(
      Effect.map((entries) => statusForAgent(entries, agentId)),
    );
  }

  /**
   * Bulk read for the `network/presence/subscribe` handler. Returns one entry
   * per requested `agentId` in input order; unknown agents resolve to
   * `"offline"`. One `Ref.get` at the start of the call; all entries
   * are read from the same snapshot.
   * @param agentIds Value supplied to the operation.
   * @returns The status many result.
   */
  statusMany(agentIds: readonly AgentId[]): Effect.Effect<
    ReadonlyArray<{
      readonly agentId: AgentId;
      readonly status: DerivedPresenceStatus;
    }>
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
