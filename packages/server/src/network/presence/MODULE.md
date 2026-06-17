# server-core/network/presence

_`packages/server/src/network/presence`_

## Purpose

Presence server internals.

## Public surface

### [`AgentPresenceEntry`](./presence-types.ts#L49)

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

### [`agentPresenceSubscribe`](./handlers.ts#L64)

_Variable_

```ts
export const agentPresenceSubscribe: ServerHandler<
  typeof AgentPresenceSubscribe
> = (params)
```

### [`appPresenceSubscribe`](./handlers.ts#L71)

_Variable_

```ts
export const appPresenceSubscribe: ServerHandler<
  typeof AppPresenceSubscribe
> = (params)
```

### [`DerivedPresenceStatus`](./presence-types.ts#L14)

_TypeAlias_

```ts
export type DerivedPresenceStatus = "online" | "working" | "offline";

/**
 * Per-agent presence entry. An agent may hold multiple simultaneous
 * WebSocket connections (web tab + CLI + mobile — see
 * `AgentEndpointResolver`'s module JSDoc), so the entry tracks the
 * full set of live connections + the active leases keyed by which
 * connection holds them.
 *
 * - `liveConns` — every WS connection the
 *   agent is currently authenticated on.
 * - `leasesByConn` — per-connection breakdown of active leases
 *   (GRANTED or CLAIMED), keyed by connection.
 *   When a connection disconnects, its bucket is dropped wholesale so
 *   the leases bound to the dead conn don't keep the agent in
 *   `working` forever.
 *
 * Invariant: every key in `leasesByConn` MUST be present in
 * `liveConns`. A lease callback that arrives bound to a
 * `recipientConnId` not in `liveConns` is a fast-reconnect race ghost
 * and no-ops (audited as `LeaseCallbackFromStaleConnection`).
 *
 * Status derivation: `working` if any live connection holds at least
 * one active lease; `online` if the entry exists but holds no active
 * leases anywhere; `offline` if the entry is absent. See
 * {@link deriveEntryStatus}.
 *
 * The multi-connection shape is correctness-by-construction: a second
 * simultaneous connection ADDS to `liveConns` rather than clobbering
 * the agent's lease set, so the original conn's active leases stay
 * accounted-for.
 *
 * "offline" is represented by entry absence; presence state NEVER
 * holds an entry whose `liveConns` is empty.
 */
export interface AgentPresenceEntry {
  readonly liveConns: ReadonlySet<ConnectionId>;
  readonly leasesByConn: ReadonlyMap<ConnectionId, ReadonlySet<LeaseId>>;
}
```

Derived presence status. Three-state set:

- `online`   — connected, no active lease.
- `working`  — connected, ≥1 lease in GRANTED or CLAIMED.
- `offline`  — WS closed (no entry in presence state).

### [`deriveEntryStatus`](./presence-types.ts#L60)

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

### [`LeaseTransitionObserver`](./presence-types.ts#L162)

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

### [`noopLeaseTransitionObserver`](./presence-types.ts#L184)

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

### [`PresenceAuditEvent`](./presence-types.ts#L105)

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

### [`PresenceService`](./presence.service.ts#L253)

_Class_

```ts
export class PresenceService implements LeaseTransitionObserver {
  private constructor(private readonly entries: Ref.Ref<EntryMap>) {}

  /**
   * Construct the service. One instance per server lifetime; wired into
   * `LeaseRegistryDeps.transitionObserver` at composition root.
   */
  static make(): Effect.Effect<PresenceService, never, never> {
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
   */
  onAgentConnect(
    agentId: AgentId,
    connId: ConnectionId,
  ): Effect.Effect<void, never, never> {
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
   */
  onAgentDisconnect(
    agentId: AgentId,
    connId: ConnectionId,
  ): Effect.Effect<void, never, never> {
    return Ref.update(this.entries, (entries) =>
      computeDisconnectTransition(entries, agentId, connId),
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
          : Effect.void,
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
   * Bulk read for the `network/presence/subscribe` handler. Returns one entry
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
```

Presence service: lease-derived status engine.

Implements LeaseTransitionObserver so the `LeaseRegistry`
can drive lease transitions through it — the registry depends on the
narrow observer contract, not on this whole surface. The WS-lifecycle
hooks (`onAgentConnect` / `onAgentDisconnect`) feed connection
transitions, and `network/presence/subscribe` reads status via `statusMany`.

**State.** One in-memory status map, lost on restart. Agents repopulate
it on reconnect. Each entry carries `liveConns` (every WS conn the agent
is authed on) + `leasesByConn` (per-conn active-lease buckets).
Multi-connection shaped: a second simultaneous connect ADDS to
`liveConns` rather than clobbering it.

**One Ref update per transition.** Every observer/lifecycle method
computes its result inside one Ref operation so status updates remain
linearized across connect, disconnect, and lease callbacks.

**Entry-creation invariant (load-bearing).** Entries are created
EXCLUSIVELY in `onAgentConnect` (first connection). Subsequent
connects add to `liveConns`; the entry is never re-created while any
conn survives. A lease callback on an unknown agent NEVER allocates
an entry; instead it audits (PresenceAuditEvent) and no-ops.
Combined with the `recipientConnId ∈ liveConns` check, stale lease
callbacks across reconnect / partial-disconnect boundaries neither mutate
state nor re-create disconnected agents.

Lease observer flow:

```mermaid
sequenceDiagram
  participant LR as LeaseRegistry
  participant PS as PresenceService
  LR->>PS: onLeaseActiveBegin(leaseId, agentId, recipientConnId)
  PS->>PS: Ref.modify computes the updated entry in one CAS
  alt agent has entry AND recipientConnId ∈ entry.liveConns
    PS->>PS: leasesByConn[recipientConnId] ∪= {leaseId}; status derives from the updated entry
  else entry exists but recipientConnId ∉ liveConns (fast-reconnect race)
    Note over PS: audit LeaseCallbackFromStaleConnection — Effect.logDebug
  else agent has no entry (disconnected)
    Note over PS: audit LeaseBeginAfterDisconnect — Effect.logDebug
  end
```

### [`PresenceServiceLive`](./layer.ts#L12)

_Variable_

```ts
export const PresenceServiceLive: Layer.Layer<
  PresenceServiceTag,
  never,
  never
> = Layer.effect(
  PresenceServiceTag,
  Effect.gen(function* () {
    return yield* PresenceService.make();
  }).pipe(Effect.withSpan("PresenceServiceLive")),
)
```

### [`PresenceServiceTag`](./layer.ts#L7)

_Class_

```ts
export class PresenceServiceTag extends Context.Tag("moltzap/PresenceService")<
  PresenceServiceTag,
  PresenceService
>() {}
```

## Files

- `handlers.ts`
- `layer.ts`
- `presence-types.ts`
- `presence.service.ts`
