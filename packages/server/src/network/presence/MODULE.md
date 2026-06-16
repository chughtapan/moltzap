# server-core/network/presence

_`packages/server/src/network/presence`_

## Purpose

Presence server internals.

## Public surface

### [`AgentPresenceEntry`](./presence-types.ts#L55)

_Interface_

```ts
export interface AgentPresenceEntry {
  readonly liveConns: ReadonlySet<ConnectionId>;
  readonly leasesByConn: ReadonlyMap<ConnectionId, ReadonlySet<LeaseId>>;
}
```

Per-agent presence entry. An agent may hold multiple simultaneous
WebSocket connections (web tab + CLI + mobile — see
`AgentEndpointResolver`'s module JSDoc), so the entry tracks the
full set of live connections + the active leases keyed by which
connection holds them.

- `liveConns` — every WS connection the
  agent is currently authenticated on.
- `leasesByConn` — per-connection breakdown of active leases
  (GRANTED or CLAIMED), keyed by connection.
  When a connection disconnects, its bucket is dropped wholesale so
  the leases bound to the dead conn don't keep the agent in
  `working` forever.

Invariant: every key in `leasesByConn` MUST be present in
`liveConns`. A lease callback that arrives bound to a
`recipientConnId` not in `liveConns` is a fast-reconnect race ghost
and no-ops (audited as `LeaseCallbackFromStaleConnection`).

Status derivation: `working` if any live connection holds at least
one active lease; `online` if the entry exists but holds no active
leases anywhere; `offline` if the entry is absent. See
deriveEntryStatus.

The multi-connection shape is correctness-by-construction: a second
simultaneous connection ADDS to `liveConns` rather than clobbering
the agent's lease set, so the original conn's active leases stay
accounted-for.

"offline" is represented by entry absence; presence state NEVER
holds an entry whose `liveConns` is empty.

### [`agentPresenceSubscribe`](./handlers.ts#L68)

_Variable_

```ts
export const agentPresenceSubscribe: ServerHandler<
  typeof AgentPresenceSubscribe
> = (params)
```

### [`appPresenceSubscribe`](./handlers.ts#L75)

_Variable_

```ts
export const appPresenceSubscribe: ServerHandler<
  typeof AppPresenceSubscribe
> = (params)
```

### [`dedupePresenceStatus`](./presence-types.ts#L92)

_Function_

```ts
export function dedupePresenceStatus(
  previous: DerivedPresenceStatus,
  next: DerivedPresenceStatus,
): Option.Option<DerivedPresenceStatus>
```

Pure algebraic dedup rule.

| previous | next    | emit             |
|----------|---------|------------------|
| online   | online  | `none`           |
| online   | working | `some(working)`  |
| working  | working | `none` (dedup)   |
| working  | online  | `some(online)`   |
| online   | offline | `some(offline)`  |
| working  | offline | `some(offline)`  |

The two-arg discipline forces the caller to NAME the previous status
at the emission site, which is how concurrent GRANTED leases stop
producing duplicate `working` notifications: the second GRANT sees
`previous = working` and elides the emission.

### [`DerivedPresenceStatus`](./presence-types.ts#L14)

_TypeAlias_

```ts
export type DerivedPresenceStatus = "online" | "working" | "offline";

/** Wire event computed from a presence transition. */
export interface PresenceEmission {
  readonly agentId: AgentId;
  readonly status: DerivedPresenceStatus;
}
```

Derived presence status. Three-state set:

- `online`   — connected, no active lease.
- `working`  — connected, ≥1 lease in GRANTED or CLAIMED.
- `offline`  — WS closed (no entry in presence state).

### [`deriveEntryStatus`](./presence-types.ts#L66)

_Function_

```ts
export function deriveEntryStatus(
  entry: AgentPresenceEntry,
): Exclude<DerivedPresenceStatus, "offline">
```

Derive presence status from an entry — total across all live
connections. Single source of truth for the lease-count-to-status
mapping; walks `leasesByConn` and returns `working` for any non-zero
count, else `online`.

### [`LeaseTransitionObserver`](./presence-types.ts#L192)

_Interface_

```ts
export interface LeaseTransitionObserver {
  readonly onLeaseActiveBegin: (
    leaseId: LeaseId,
    recipientAgentId: AgentId,
    recipientConnId: ConnectionId,
  ) => Effect.Effect<void, never, never>;
  readonly onLeaseActiveEnd: (
    leaseId: LeaseId,
    recipientAgentId: AgentId,
    recipientConnId: ConnectionId,
  ) => Effect.Effect<void, never, never>;
}
```

Observer surface the `LeaseRegistry` calls at each transition
that crosses the lease's "active for presence" boundary. "Active"
means GRANTED or CLAIMED — the two states that count toward
`working`.

This is the NARROW contract `LeaseRegistry` depends on. The registry
sees only these two methods, not the full `PresenceService` surface.

- `onLeaseActiveBegin` fires on `PENDING → GRANTED` only. `HOLD →
  PENDING → GRANTED` (verdict re-try) eventually reaches GRANTED, at
  which point this fires; the intermediate HOLD never enters the
  active set.
- `onLeaseActiveEnd` fires on the lease's first exit from
  GRANTED-or-CLAIMED into a terminal state — `CLAIMED → CONSUMED`,
  `GRANTED → EXPIRED` (TTL), `GRANTED → EXPIRED-on-disconnect`. A
  `CLAIMED → GRANTED` rollback is NOT an end event (still active).
  A `PENDING → DENIED | ABANDONED | HOLD` transition is NOT an end
  event (never entered the active set).

Public error channel is `never` — presence is best-effort and MUST
NOT propagate failure to the lease registry mutator.

**`recipientConnId` parameter.** Threads the lease's
`binding.recipientConnectionId` so the service can check
`recipientConnId ∈ entry.liveConns` and drop fast-reconnect-race
ghost callbacks. The fast-reconnect race: agent A disconnects on
`connId-1`, the disconnect handler drops `connId-1` from A's
`liveConns`, A reconnects fast on `connId-2`, then the pending
`leaseRegistry.abandon(connId-1)` synchronously fires
`onLeaseActiveEnd` for each of A's old leases. Without connId
threading, those callbacks would mutate against the surviving
connection; the check makes them no-op audits instead.

### [`noopLeaseTransitionObserver`](./presence-types.ts#L214)

_Variable_

```ts
export const noopLeaseTransitionObserver: LeaseTransitionObserver =
```

Default observer used by `LeaseRegistry`'s `transitionObserver`
when the registry is constructed without a presence service (e.g. in
`lease-registry.test.ts` unit tests that do not exercise presence).

The default discipline (Principle 4) is to have a value that does the
right thing rather than a `null` branch every call site has to
remember to guard.

### [`PresenceAuditEvent`](./presence-types.ts#L135)

_TypeAlias_

```ts
export type PresenceAuditEvent =
  | {
      readonly _tag: "LeaseEndAfterDisconnect";
      readonly agentId: AgentId;
      readonly leaseId: LeaseId;
    }
```

Audit-event taxonomy for "expected during teardown" lease callbacks.

- **`LeaseEndAfterDisconnect`** — `onLeaseActiveEnd` fires for an
  agent whose entry has already been dropped by `onAgentDisconnect`.
  `closeSocketSession` runs `onAgentDisconnect` BEFORE
  `leaseRegistry.abandon(connId)`, and abandon synchronously fires
  `onLeaseActiveEnd` for every active lease bound to the connection.

- **`LeaseBeginAfterDisconnect`** — `onLeaseActiveBegin` fires
  between `onAgentDisconnect` and `leaseRegistry.abandon`, when a
  concurrent `resolveLease(grant)` on a different connection's
  moderator verdict lands during the disconnect window. The
  entry-creation invariant (only `onAgentConnect` creates entries)
  means the begin is correctly dropped without re-creating a ghost
  entry.

- **`LeaseCallbackFromStaleConnection`** — a lease callback fires
  with a `recipientConnId` that is NOT in the entry's current
  `liveConns` set. The fast-reconnect race: agent A's `connId-1`
  disconnects (removed from `liveConns`), A reconnects on
  `connId-2`, and the pending `leaseRegistry.abandon(connId-1)`
  fires `onLeaseActiveEnd` for A's old leases carrying the now-stale
  `connId-1`. The callback is a silent no-op (no state mutation, no
  emission). `currentConnId` reports an arbitrary stable witness
  from `liveConns` (the first, insertion-ordered) for diagnostics.

Idempotent set operations (double `onLeaseActiveEnd` for the same
lease id on an entry whose `recipientConnId` IS in `liveConns`) are
silent — no audit, no emission. The audit class is specifically for
the disconnect-window and fast-reconnect race cases.

Audit events are emitted via `Effect.logDebug`. They do NOT go
through `Effect.die`; the `never` E channel is preserved by
construction.

### [`PresenceEmission`](./presence-types.ts#L17)

_Interface_

```ts
export interface PresenceEmission {
  readonly agentId: AgentId;
  readonly status: DerivedPresenceStatus;
}
```

Wire event computed from a presence transition.

### [`PresenceService`](./presence.service.ts#L374)

_Class_

```ts
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
   * (`dedupePresenceStatus`) is the sole gate; this is the only path
   * from in-memory state to wire publish.
   */
  private emit(
    previous: DerivedPresenceStatus,
    next: DerivedPresenceStatus,
    agentId: AgentId,
  ): Effect.Effect<void, never, never> {
    return Effect.gen(this, function* () {
      const decision = dedupePresenceStatus(previous, next);
      if (Option.isNone(decision)) return;
      const subscriberConnIds = new Set(this.getSubscribers(agentId));
      yield* fanOut(
        this.connections,
        agentId,
        decision.value,
```

Presence service: subscriber registry + lease-derived status engine
+ `network/presence-changed` fan-out.

Implements LeaseTransitionObserver so the `LeaseRegistry`
can drive lease transitions through it — the registry depends on the
narrow observer contract, not on this whole surface. The WS-lifecycle
hooks (`onAgentConnect` / `onAgentDisconnect`) feed connection
transitions, and `network/presence/subscribe` reads status via `statusMany`
and registers fan-out interest via `subscribe`.

**State.** Two in-memory stores, both lost on restart (agents
repopulate on reconnect):

- subscriber registry — `subscribers` maps each agent ID to the connection
  IDs watching it (which
  connections want fan-out for which agent) plus the reverse
  `connSubscriptions` map so `subscribe` can
  replace a connection's watch set without scanning every agent.
- status map — a `Ref` of agent ID to presence entry. Each
  entry carries `liveConns` (every WS conn the agent is authed on) +
  `leasesByConn` (per-conn active-lease buckets). Multi-connection
  shaped: a second simultaneous connect ADDS to `liveConns` rather
  than clobbering it.

**One `Ref.modify` per transition, linearizing both state AND
emission decision.** Every observer/lifecycle method computes its
result inside a single `Ref.modify` predicate, then publishes the
dedup-gated emission AFTER the CAS commits. The dedup rule
(dedupePresenceStatus) NAMES the previous status at the
emission site, so concurrent GRANTED leases elide duplicate
`working` notifications.

**Entry-creation invariant (load-bearing).** Entries are created
EXCLUSIVELY in `onAgentConnect` (first connection). Subsequent
connects add to `liveConns`; the entry is never re-created while any
conn survives. A lease callback on an unknown agent NEVER allocates
an entry; instead it audits (PresenceAuditEvent) and no-ops.
Combined with the `recipientConnId ∈ liveConns` check, every full
disconnect (last conn) produces exactly one `offline` emission, and
stale lease callbacks across reconnect / partial-disconnect
boundaries neither mutate state nor emit.

Emission flow (lease-observer path; the lifecycle path is the same
dispatch minus the audit arms):

```mermaid
sequenceDiagram
  participant LR as LeaseRegistry
  participant PS as PresenceService
  participant Subs as Subscribers (WS clients)

  LR->>PS: onLeaseActiveBegin(leaseId, agentId, recipientConnId)
  PS->>PS: Ref.modify computes BOTH new entry AND emission decision in one CAS
  alt agent has entry AND recipientConnId ∈ entry.liveConns
    PS->>PS: prev = deriveEntryStatus(entry); leasesByConn[recipientConnId] ∪= {leaseId}; next = any bucket non-empty ? "working" : "online"
    PS->>PS: dedupePresenceStatus(prev, next) — dedup
    alt decision = some(status)
      PS->>PS: snapshot = new Set(getSubscribers(agentId))
      PS->>Subs: network/presence-changed { agentId, status }
    else decision = none
      Note over PS: dedup — concurrent GRANTED, no fan-out
    end
  else entry exists but recipientConnId ∉ liveConns (fast-reconnect race)
    Note over PS: audit LeaseCallbackFromStaleConnection — Effect.logDebug, no emission
  else agent has no entry (disconnected)
    Note over PS: audit LeaseBeginAfterDisconnect — Effect.logDebug, no emission
  end
```

## Files

- `handlers.ts`
- `presence-types.ts`
- `presence.service.ts`
