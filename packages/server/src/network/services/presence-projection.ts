/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import { Context, Effect, Ref } from "effect";

import type { AgentId } from "@moltzap/protocol/identity";
import type { LeaseId } from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";

import type { ConnectionManager } from "../../transport/connection.js";

// v6 (codex r5 P2 #2): the raw fan-out sink, its factory, and the
// curried emit capability live in `_internal/presence-emit.ts`. This
// module imports only `createEmitIfChanged` (which it calls once
// inside `makePresenceProjection`'s factory) and the `EmitIfChanged`
// type. The raw `InternalPresenceEventSink` interface +
// `createInternalFanOutEventSink` factory are unreachable from this
// module — the in-module dedup seal is structural at the directory
// boundary.
import { createEmitIfChanged } from "./_internal/presence-emit.js";
import type { EmitIfChanged } from "./_internal/presence-emit.js";

// v6: shared types in a sibling file. v7 (codex r6 P2 #4 three-canary
// seal): `emitPresenceTransition` moved here so the @ts-expect-error
// canary on `_internal/presence-emit.ts` is now a real TS2305 seal
// (the pure helper is NOT exported from `_internal/`). v7 (codex r6
// P2 #1 size-derived status): `AgentPresenceEntry.status` removed;
// `deriveEntryStatus(entry)` exported from here as the single
// source-of-truth helper. v7 (codex r6 P2 #1 follow-on):
// `PresenceProjectionDefect` + `catchProjectionDefect` deleted
// entirely — the only `reason` was `entry-status-size-mismatch`,
// which is now structurally impossible. No projection-specific
// defect class remains.
import {
  type AgentPresenceEntry,
  deriveEntryStatus,
  type DerivedPresenceStatus,
  emitPresenceTransition,
  type PresenceEmission,
  type PresenceSubscriberRegistry,
} from "./presence-projection-types.js";

// ── Architect-contract re-exports (v6+) ─────────────────────────────
//
// These names are part of the architect's public contract; they were
// originally declared inline in this file pre-v6. v6 split the
// implementation across `presence-projection-types.ts` (types + pure
// fns) and `_internal/presence-emit.ts` (sink + factory + curry) to
// close the in-module seal hole codex r5 P2 #2 identified; v7 added
// `deriveEntryStatus` per codex r6 P2 #1 (size-derived status). Callers
// MUST continue to import from `presence-projection.js` — the new
// sub-files are implementation detail.
export type {
  AgentPresenceEntry,
  DerivedPresenceStatus,
  PresenceEmission,
  PresenceSubscriberRegistry,
};
export type { EmitIfChanged };
export { deriveEntryStatus, emitPresenceTransition };

/**
 * Observer surface the {@link LeaseRegistry} calls at each transition
 * that crosses the lease's "active for presence" boundary. "Active"
 * means the lease is in GRANTED or CLAIMED — those are the two states
 * that count toward `working`.
 *
 * Two transition shapes are observed; everything else is silently
 * filtered at the registry's emission sites:
 *
 * - `onLeaseActiveBegin` fires on `PENDING → GRANTED` only. `HOLD →
 *   PENDING → GRANTED` (verdict re-try) eventually reaches GRANTED, at
 *   which point this fires; the intermediate HOLD never enters the
 *   active set.
 * - `onLeaseActiveEnd` fires on the lease's first exit from
 *   GRANTED-or-CLAIMED into a terminal state — `CLAIMED → CONSUMED`,
 *   `GRANTED → EXPIRED` (TTL), `GRANTED → EXPIRED-on-disconnect`. A
 *   `CLAIMED → GRANTED` rollback is NOT an end event (still active).
 *   A `PENDING → DENIED | ABANDONED | HOLD` transition is NOT an end
 *   event (never entered the active set).
 *
 * Public error channel is `never` — the projection is best-effort and
 * MUST NOT propagate failure to the lease registry mutator.
 *
 * **`recipientConnId` parameter.** The fast-reconnect race — agent
 * A disconnects on `connId-1`, the disconnect handler drops `connId-1`
 * from A's `liveConns`, A reconnects fast on `connId-2`, the
 * projection adds `connId-2` to `liveConns`, THEN the
 * `leaseRegistry.abandon(connId-1)` synchronously fires
 * `onLeaseActiveEnd` for each of A's old leases — would, without
 * connId threading, see A's entry and mutate against the surviving
 * connection. The callback threads the lease's
 * `binding.recipientConnectionId` so the projection can check
 * `recipientConnId ∈ entry.liveConns`; if absent (multi-conn fix:
 * could mean the conn fully disconnected OR the agent never had it),
 * the callback emits a {@link PresenceProjectionAuditEvent} of
 * `_tag: "LeaseCallbackFromStaleConnection"` and is a silent no-op
 * (no state mutation, no emission). The single `offline` from
 * `disconnect-on-connId-1` (when liveConns was empty) stands; the
 * new `online` from `connect-on-connId-2` stands; the stale lease
 * callbacks neither mutate nor emit.
 */
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

/**
 * Default observer used by {@link LeaseRegistryDeps.transitionObserver}
 * when the registry is constructed without a projection (e.g. in
 * `lease-registry.test.ts` unit tests that do not exercise presence).
 *
 * Replaces the v1 plan's nullable `transitionObserver: LeaseTransitionObserver | null`
 * shape. The default discipline (Principle 4) is to have a value that
 * does the right thing rather than a `null` branch every call site has
 * to remember to guard. Test harnesses that DO need projection
 * observation construct `makePresenceProjection` and pass it in.
 */
// architect stub convention: noop default declared inline. Bodies
// fall through to `throw new Error("not implemented")` per
// safer-by-default architect SKILL.md so impl-staff fills in the
// noop behavior (each method should return `Effect.void`). The stub
// value satisfies the LeaseTransitionObserver shape at the type
// level so consumers can reference the constant in default-arg
// positions; calling it would `throw` until impl-staff lands.
export const noopLeaseTransitionObserver: LeaseTransitionObserver = {
  onLeaseActiveBegin: () => Effect.void,
  onLeaseActiveEnd: () => Effect.void,
};

/**
 * Constructor inputs for {@link makePresenceProjection}.
 *
 * Two deps:
 *
 * - `subscribers` — read-only access to the subscriber registry (which
 *   conn ids care about which agent id). Sourced from `PresenceService`
 *   (the surviving non-mutating portion). The projection snapshots the
 *   read into a new `Set` before iterating at the emission site.
 * - `connections` — `ConnectionManager` from Tier 1. Passed through to
 *   {@link createEmitIfChanged} inside the factory body so the
 *   internal sink can write per-connection `presence/changed` frames.
 *   The factory NEVER takes a sink as a dep — taking a sink would
 *   re-open the capability hole codex P2 #4 identified. The sink is
 *   constructed inside `createEmitIfChanged`'s closure in
 *   `_internal/presence-emit.ts`, full stop.
 *
 * Decision (in-memory vs persisted): in-memory. Matches `LeaseRegistry`'s
 * model; restart drops the projection state and agents repopulate it on
 * reconnect (WS `connect` → `online`). A persisted store would have to
 * reconcile with the in-memory `LeaseRegistry` on boot, which adds an
 * inconsistency window with zero corresponding benefit (the recovery
 * path through reconnect already runs in seconds). The store is
 * `Ref<ReadonlyMap<AgentId, AgentEntry>>` — the same shape `LeaseRegistry`
 * uses for its entries.
 */
export interface PresenceProjectionDeps {
  readonly subscribers: PresenceSubscriberRegistry;
  readonly connections: ConnectionManager;
}

/**
 * Audit-event taxonomy for "expected during teardown" lease callbacks.
 *
 * Refined per codex r2 P2 #2 + P2 #3 (v3); narrowed per codex r3 P2 #1
 * (v4); extended per codex r5 P2 #1 (v6 — the fast-reconnect race
 * adds `LeaseCallbackFromStaleConnection`).
 *
 * Three variants:
 *
 * - **`LeaseEndAfterDisconnect`** — `onLeaseActiveEnd(leaseId, agentId,
 *   recipientConnId)` fires for an agent whose entry was already
 *   dropped by `onAgentDisconnect`. EXPECTED: `closeSocketSession`
 *   runs `onAgentDisconnect` BEFORE `leaseRegistry.abandon(connId)`,
 *   and abandon synchronously fires `onLeaseActiveEnd` for every
 *   active lease bound to the connection. Not a defect; logged at
 *   debug.
 *
 * - **`LeaseBeginAfterDisconnect`** — `onLeaseActiveBegin(leaseId,
 *   agentId, recipientConnId)` fires between `onAgentDisconnect` and
 *   `leaseRegistry.abandon`, when a concurrent `resolveLease(grant)`
 *   on a different connection's moderator verdict lands during the
 *   disconnect window. EXPECTED in the race described in §5; the
 *   entry-creation invariant (only `onAgentConnect` creates entries)
 *   means the begin is correctly dropped without re-creating a ghost
 *   entry. Not a defect; logged at debug.
 *
 * - **`LeaseCallbackFromStaleConnection`** —
 *   `onLeaseActiveBegin` OR `onLeaseActiveEnd` fires with a
 *   `recipientConnId` that is NOT in the projection entry's current
 *   `liveConns` set. EXPECTED in the fast-reconnect race: agent A's
 *   `connId-1` disconnects (the projection removed it from
 *   `liveConns`), A reconnects on `connId-2`, and the pending
 *   `leaseRegistry.abandon(connId-1)` fires `onLeaseActiveEnd` for
 *   A's old leases — those callbacks carry
 *   `recipientConnId = connId-1`, which is no longer in `liveConns`.
 *   Not a defect; logged at debug. The callback is a silent no-op
 *   (no state mutation, no emission). The `kind` field
 *   discriminates begin-vs-end so operators can grep by callback
 *   type. `currentConnId` reports an arbitrary stable witness from
 *   `liveConns` (the first one, insertion-ordered) for diagnostic
 *   purposes — the agent may have several simultaneous connections.
 *
 * Idempotent set operations (double `onLeaseActiveEnd` for the same
 * lease id on an EXISTING agent entry whose `recipientConnId` IS in
 * `liveConns`) are silent — the per-conn set-delete returns false,
 * no audit, no emission, no defect. The audit class is specifically
 * for the disconnect-window and fast-reconnect race cases.
 *
 * Audit events are emitted via `Effect.logDebug` (structured logging
 * with `_tag` discrimination over the variants). The audit stream does
 * NOT go through `Effect.die`; it is plain debug logging. The
 * `LeaseTransitionObserver`'s `never` E channel is preserved by
 * construction (audit logs are side effects in the `Effect.sync`
 * channel; they do not type-leak).
 */
export type PresenceProjectionAuditEvent =
  | {
      readonly _tag: "LeaseEndAfterDisconnect";
      readonly agentId: AgentId;
      readonly leaseId: LeaseId;
    }
  | {
      readonly _tag: "LeaseBeginAfterDisconnect";
      readonly agentId: AgentId;
      readonly leaseId: LeaseId;
    }
  | {
      readonly _tag: "LeaseCallbackFromStaleConnection";
      readonly agentId: AgentId;
      readonly leaseId: LeaseId;
      /** Which observer callback fired with the stale connId. */
      readonly kind: "begin" | "end";
      /** The stale connId the callback carried. */
      readonly staleConnId: ConnectionId;
      /** The projection entry's current connId at audit time. */
      readonly currentConnId: ConnectionId;
    };

// PresenceProjectionDefect — DELETED in v7 (codex r6 P2 #1).
//
// v3-v6 carried `PresenceProjectionDefect` as a `Data.TaggedError`
// surfaced via `Effect.die(...)` and caught at the projection's outer
// edge by `catchProjectionDefect` (narrowed v5). The only `reason`
// that survived prior rounds was `entry-status-size-mismatch` — a
// guard against `AgentPresenceEntry.status` disagreeing with
// `activeLeases.size`. v7 deletes `AgentPresenceEntry.status` (status
// is now derived from `set.size` via `deriveEntryStatus`), which
// makes the mismatch structurally impossible by construction. With
// no remaining genuinely-impossible reasons, both
// `PresenceProjectionDefect` AND `catchProjectionDefect` are deleted
// from the architect surface. Unrelated programmer defects propagate
// up through the fiber supervisor naturally (the public methods'
// `never` E channel is preserved by `Effect.void` returns on every
// reachable path).

/**
 * Public surface of the presence projection.
 *
 * The projection observes two boundaries:
 *
 * - **Lease boundary** — implements {@link LeaseTransitionObserver};
 *   wired into `LeaseRegistryDeps.transitionObserver` (new dep on
 *   `LeaseRegistry`, defaults to {@link noopLeaseTransitionObserver}).
 *   The registry calls into these methods from its `resolveLease`,
 *   `finalizeClaim`, `expireLeaseFromTtl`, and `expireLeaseOnDisconnect`
 *   sites, threading the lease's `binding.recipientConnectionId` as
 *   the third arg per v6 (codex r5 P2 #1).
 *
 * - **Connection boundary** — `onAgentConnect` and `onAgentDisconnect`
 *   are called from the WS-lifecycle hooks. Currently those sites are:
 *
 *   - Connect: `packages/server/src/identity/handlers/connect.handlers.ts → buildHelloOk`
 *     (replaces the existing `presenceService.setOnline(ctx.agentId)` call).
 *   - Disconnect: `packages/server/src/app/socket-handler.ts → closeSocketSession`
 *     (replaces the existing `presenceService.setOffline(authCtx.agentId)` call).
 *
 * **WS-lifecycle methods carry `connId`.** Both `onAgentConnect`
 * and `onAgentDisconnect` take a `connId: ConnectionId` second
 * parameter. Round-5 codex P2 fix — multi-connection-per-agent:
 * `onAgentConnect(agentId, connId-2)` ADDS `connId-2` to the
 * agent's `liveConns` set (does NOT replace the prior connId);
 * `onAgentDisconnect(agentId, connId-1)` removes `connId-1` from
 * `liveConns` and drops its per-conn lease bucket. The entry is
 * deleted only when `liveConns` becomes empty.
 *
 * **Status read surface (codex r2 P2 #1 fix):** `PresenceProjection.statusOf`
 * + `statusMany` migrate the read from `PresenceService.get`/`getMany`
 * (deleted in §8 cutover).
 *
 * **Entry-creation rule (load-bearing — covers the
 * concurrent-grant-during-disconnect race):** entries are created
 * EXCLUSIVELY in `onAgentConnect` (first connection). Subsequent
 * `onAgentConnect` calls add to `liveConns`; the entry itself is
 * never re-created while any conn survives. `onLeaseActiveBegin`
 * on an unknown agent NEVER allocates an entry; instead it emits a
 * {@link PresenceProjectionAuditEvent} of `_tag:
 * "LeaseBeginAfterDisconnect"` (logged at debug) and returns
 * `Effect.void`. Combined with the `recipientConnId ∈ liveConns`
 * check, every full disconnect (last conn) produces exactly one
 * `offline` emission, and stale lease callbacks across reconnect /
 * partial-disconnect boundaries neither mutate state nor emit.
 *
 * The "emit `offline` on full disconnect" rule (Acceptance #4)
 * lives exclusively in `onAgentDisconnect`. Combined with the
 * never-recreate rule and the conn-in-liveConns guard, every
 * full disconnect produces exactly one `offline` emission on the
 * wire; concurrent lease transitions during the disconnect window
 * produce zero stale `online`/`working` emissions; fast reconnects
 * produce a clean `online` (from the new `onAgentConnect`) without
 * ghost `working` leaks from the old session's pending lease
 * callbacks. Multi-conn agents fire `offline` only when their
 * LAST live connection drops; intermediate disconnects re-derive
 * status from the surviving conns' lease buckets.
 *
 * Emission flow (the rule in code):
 *
 * ```mermaid
 * sequenceDiagram
 *   participant LR as LeaseRegistry
 *   participant PP as PresenceProjection
 *   participant Emit as EmitIfChanged (v6 — closes over sealed sink in `_internal/`)
 *   participant Subs as Subscribers (WS clients)
 *
 *   LR->>PP: onLeaseActiveBegin(leaseId, agentId, recipientConnId)
 *   PP->>PP: Ref.modify computes BOTH new entry AND emission decision in one CAS
 *   alt agent has entry AND recipientConnId ∈ entry.liveConns
 *     PP->>PP: prev = deriveEntryStatus(entry)<br>leasesByConn[recipientConnId] ∪= {leaseId}<br>next = any bucket non-empty ? "working" : "online"
 *     PP->>Emit: emit(prev, next, agentId)
 *     Emit-->>Emit: emitPresenceTransition(prev, next) — dedup
 *     alt decision = some(status)
 *       Emit-->>Emit: snapshot = new Set(subscribers.getSubscribers(agentId))
 *       Emit->>Subs: presence/changed { agentId, status }
 *     else decision = none
 *       Note over Emit: dedup — concurrent GRANTED, no fan-out
 *     end
 *   else entry exists but recipientConnId ∉ liveConns (fast-reconnect race)
 *     Note over PP: audit LeaseCallbackFromStaleConnection — Effect.logDebug, no emission
 *   else agent has no entry (disconnected)
 *     Note over PP: audit LeaseBeginAfterDisconnect — Effect.logDebug, no emission
 *   end
 * ```
 *
 * Mirror flow for `onLeaseActiveEnd` (same dispatch — Ref.modify, then
 * Option-gated emit; absent-entry case audits as
 * `LeaseEndAfterDisconnect`; conn-not-in-liveConns case audits as
 * `LeaseCallbackFromStaleConnection`), `onAgentConnect` (creates
 * entry on first connection OR adds connId to existing entry's
 * liveConns; `online` is emitted only on first connection — additional
 * simultaneous conns dedup-elide), and `onAgentDisconnect` (removes
 * connId from liveConns + drops `leasesByConn[connId]`; emits
 * `offline` only when `liveConns` empties out, else re-derives from
 * the surviving conns' lease buckets).
 */
export interface PresenceProjection extends LeaseTransitionObserver {
  /**
   * WS connect: add `connId` to the agent's `liveConns` and emit
   * `online` on first connection. Multi-connection-shaped (round-5
   * codex P2 fix): an agent may hold multiple simultaneous WS
   * connections (web tab + CLI + mobile — see
   * `AgentEndpointResolver` for the server's multi-conn model), so
   * a second simultaneous connect ADDS to the set rather than
   * replacing it.
   *
   * Three cases (single `Ref.modify` predicate):
   *
   * 1. **Agent was offline (no entry).** Allocate
   *    `{ liveConns: {connId}, leasesByConn: {} }`; emit
   *    `offline → online`.
   *
   * 2. **`connId` already in `liveConns` (idempotent redundant connect).**
   *    No-op; status stays at whatever the existing leases imply
   *    (`online` or `working`). The `network/connect` handler's
   *    `if (conn.auth) { return yield* buildHelloOk(...) }`
   *    early-return makes this reachable in normal operation. v4
   *    codex r3 P2 #1.
   *
   * 3. **New simultaneous connection.** Add `connId` to `liveConns`;
   *    do NOT touch `leasesByConn` (the existing leases stay bound
   *    to their original conns). Status stays at `working` if any
   *    bucket is non-empty, else `online` — either way, dedup
   *    elides emission. This is the round-5 codex P2 fix: a second
   *    simultaneous connection used to clobber `activeLeases` and
   *    emit a spurious `online`. It now never does.
   *
   * **Stale-conn audit** (`LeaseCallbackFromStaleConnection`) is
   * preserved by the fact that lease callbacks are routed by
   * `recipientConnId ∈ liveConns?`. After a fast disconnect →
   * reconnect-on-new-connId, the OLD conn is no longer in
   * `liveConns`, so any pending `leaseRegistry.abandon(oldConnId)`
   * fan-out audits.
   *
   * Public error channel is `never` — this runs inside the connect
   * handler and MUST NOT block the connect path on emission failure.
   */
  readonly onAgentConnect: (
    agentId: AgentId,
    connId: ConnectionId,
  ) => Effect.Effect<void, never, never>;

  /**
   * WS disconnect: remove `connId` from the agent's `liveConns` and
   * drop its `leasesByConn[connId]` bucket. Called BEFORE
   * `LeaseRegistry.abandon(connId)` from the WS-close finalizer.
   *
   * Two cases (single `Ref.modify` predicate):
   *
   * 1. **Last live connection.** `liveConns` becomes empty after the
   *    removal; drop the entry; emit `(prevStatus) → offline`.
   *
   * 2. **Other connections still live.** Remove `connId` from
   *    `liveConns`; drop `leasesByConn[connId]` so leases bound to
   *    the dead conn stop counting toward `working`. Status is
   *    re-derived from the remaining leases on the surviving
   *    connections — if the dead conn was the only one holding an
   *    active lease, the agent flips `working → online`; otherwise
   *    stays `working`.
   *
   * **Stale disconnect** — if `connId` is not in `liveConns` (the
   * agent has already reconnected on a newer connection and this
   * disconnect is for an old session that was never tracked, OR a
   * test scenario fires disconnect for an unknown conn) — silent
   * no-op.
   *
   * The pre-`abandon` ordering means the subsequent
   * `leaseRegistry.abandon`'s `onLeaseActiveEnd` callbacks for
   * `connId`'s leases find `connId` absent from `liveConns` and
   * audit as `LeaseCallbackFromStaleConnection` (no emission). The
   * projection's per-conn cleanup at disconnect time is the
   * canonical source-of-truth; the registry-driven callbacks are
   * defense-in-depth.
   *
   * Public error channel is `never`.
   */
  readonly onAgentDisconnect: (
    agentId: AgentId,
    connId: ConnectionId,
  ) => Effect.Effect<void, never, never>;

  /**
   * Read the agent's current projected status. Returns `"offline"`
   * for an unknown agent.
   *
   * Replaces `PresenceService.get` (deleted in §8). Used by
   * `presence/subscribe` handler + tests. Snapshot consistency: each
   * call reads the projection's `Ref` once via `Ref.get`; the result
   * is a point-in-time snapshot, no transaction guarantee across
   * multiple `statusOf` calls.
   *
   * NOT used on the emission hot path; the projection reads its own
   * `Ref` internally during `Ref.modify`.
   */
  readonly statusOf: (
    agentId: AgentId,
  ) => Effect.Effect<DerivedPresenceStatus, never, never>;

  /**
   * Bulk read for the `presence/subscribe` handler. Returns one entry
   * per requested `agentId` in input order; unknown agents resolve to
   * `"offline"`.
   *
   * Replaces `PresenceService.getMany` (deleted in §8). The
   * `presence.handlers.ts → presence/subscribe` rewrites from
   * `presenceService.getMany(visibleIds)` to
   * `yield* presenceProjection.statusMany(visibleIds)`.
   *
   * Snapshot consistency: one `Ref.get` is performed at the start of
   * the call; all entries in the returned array are read from the
   * same snapshot. Concurrent emission decisions taken DURING the
   * iteration cannot interleave (the `Ref.get` returns the immutable
   * `ReadonlyMap` value; `Ref.modify` publishes the NEW map
   * atomically).
   */
  readonly statusMany: (agentIds: ReadonlyArray<AgentId>) => Effect.Effect<
    ReadonlyArray<{
      readonly agentId: AgentId;
      readonly status: DerivedPresenceStatus;
    }>,
    never,
    never
  >;
}

// catchProjectionDefect — DELETED in v7 (codex r6 P2 #1 follow-on).
//
// v4 (codex r3 P3 #2) introduced `catchProjectionDefect` as a named
// defect-boundary wrapper; v5 (codex r4 P2 #3) narrowed it to
// `instanceof PresenceProjectionDefect` so unrelated programmer
// defects re-die. v7 deletes `PresenceProjectionDefect` entirely
// (the only `reason` was `entry-status-size-mismatch`, which is now
// structurally impossible because `AgentPresenceEntry.status` was
// deleted). The wrapper had nothing left to catch.
//
// Unrelated programmer defects propagate up through the fiber
// supervisor naturally. The public methods' `never` E channel is
// preserved by `Effect.void` returns on every reachable path inside
// the impl-staff bodies — there is no `Effect.die` call site inside
// the projection.

/**
 * Construct the projection. One instance per server lifetime; wired
 * into `LeaseRegistryDeps.transitionObserver` at composition root
 * (`packages/server/src/app/layers.ts` — Tier 2.55, between Tier 2
 * (Presence + AgentEndpointResolver) and Tier 2.6 (LeaseRegistry); the
 * projection consumes `PresenceServiceTag` for the subscriber-registry
 * read interface plus `ConnectionManagerTag` for the
 * internally-constructed fan-out sink (via
 * {@link createEmitIfChanged} from `_internal/presence-emit.ts`), and
 * `LeaseRegistryLive` threads the projection as its
 * `transitionObserver`).
 *
 * **Implementation contract (the bit impl-staff fills in):**
 *
 * 1. **State store** — `Ref<ReadonlyMap<AgentId, AgentPresenceEntry>>`
 *    (in-memory; matches `LeaseRegistry`). Each entry carries
 *    `liveConns: Set<ConnectionId>` (every WS conn the agent is
 *    authed on) + `leasesByConn: Map<ConnectionId, Set<LeaseId>>`
 *    (per-conn active-lease buckets). Round-5 codex P2 fix
 *    multi-conn-shaped.
 *
 * 2. **One Ref.modify per transition, linearizing both state AND
 *    emission decision** — every observer/lifecycle method computes
 *    its result inside a single `Ref.modify` predicate, then publishes
 *    the `Option`-equivalent decision on the `Some` arm AFTER the CAS
 *    commits. This is the linearization boundary codex r1 P2 #5 asked
 *    for.
 *
 *    Every transition method takes the in-module-curried
 *    {@link EmitIfChanged} value as its emit capability — NEVER the
 *    raw `InternalPresenceEventSink` (which lives in
 *    `_internal/presence-emit.ts` and is not even importable from
 *    THIS module per v6 / codex r5 P2 #2). Dedup + snapshot are
 *    folded into `emit(prev, next, agentId)`.
 *
 *    Pseudocode (lifecycle path — `onAgentConnect(agentId, connId)` /
 *    `onAgentDisconnect(agentId, connId)`):
 *
 *    ```
 *    const transition = yield* Ref.modify(entriesRef, (entries) => {
 *      const entry = entries.get(agentId);
 *      // onAgentConnect:
 *      //   - no entry → create { liveConns: {connId}, leasesByConn: {} }
 *      //   - entry, connId already in liveConns → idempotent no-op
 *      //   - entry, new connId → add to liveConns; preserve leasesByConn
 *      // onAgentDisconnect:
 *      //   - connId not in liveConns → silent no-op
 *      //   - liveConns becomes empty after removal → drop entry
 *      //   - else → remove connId from liveConns; drop leasesByConn[connId]
 *      const [nextEntries, prevStatus, nextStatus] = computeLifecycle(entries, entry, connId);
 *      return [{ prevStatus, nextStatus }, nextEntries];
 *    });
 *    yield* emit(transition.prevStatus, transition.nextStatus, agentId);
 *    ```
 *
 *    Pseudocode (lease-observer path — `onLeaseActiveBegin(leaseId,
 *    agentId, recipientConnId)` / `onLeaseActiveEnd(leaseId, agentId,
 *    recipientConnId)`):
 *
 *    ```
 *    const result = yield* Ref.modify(entriesRef, (entries) => {
 *      const entry = entries.get(agentId);
 *      if (!entry) {
 *        // Audit-event path — entry was dropped by onAgentDisconnect
 *        // before this lease callback fired. Expected during teardown.
 *        return [{ _tag: "audit", event: auditAbsentEntry(...) }, entries];
 *      }
 *      if (!entry.liveConns.has(recipientConnId)) {
 *        // Fast-reconnect race. The callback belongs to a now-dead
 *        // connection; the projection has already removed it from
 *        // liveConns.
 *        return [{ _tag: "audit", event: auditStaleConnId(...) }, entries];
 *      }
 *      const prev = deriveEntryStatus(entry);
 *      // Bucket update: add/remove leaseId in leasesByConn[recipientConnId].
 *      const nextEntry = applyLeaseToEntry(entry, kind, leaseId, recipientConnId);
 *      const next = deriveEntryStatus(nextEntry);  // walks all buckets
 *      return [
 *        { _tag: "transition", prevStatus: prev, nextStatus: next },
 *        setReadonlyMapValue(agentId, nextEntry)(entries),
 *      ];
 *    });
 *    yield* result._tag === "audit"
 *      ? Effect.logDebug("presence projection audit", result.event)
 *      : emit(result.prevStatus, result.nextStatus, agentId);
 *    ```
 *
 *    `emit` is the only path from in-module state to wire publish —
 *    see (6.1) below for the in-module seal rationale (now structural
 *    at the directory boundary per v6).
 *
 * 3. **Entry-creation invariant** — only `onAgentConnect` creates
 *    entries (and adds to `liveConns` on subsequent simultaneous
 *    connects). `onLeaseActiveBegin`/`onLeaseActiveEnd` on an
 *    unknown agent OR on an agent whose `recipientConnId ∉
 *    liveConns` emit {@link PresenceProjectionAuditEvent} (logged
 *    at debug). v7 deletes the `PresenceProjectionDefect` class
 *    entirely — the only remaining `reason`
 *    (`entry-status-size-mismatch`) is structurally impossible now
 *    that `entry.status` is derived.
 *
 * 4. **Concurrent-grant-during-disconnect + fast-reconnect races
 *    + multi-conn-per-agent** — all closed by (3) plus the
 *    `recipientConnId ∈ liveConns` guard. The multi-conn case
 *    (round-5 codex P2 fix) is correctness-by-construction: a
 *    second simultaneous connect ADDS to `liveConns` rather than
 *    clobbering it, so the original conn's active leases stay
 *    accounted-for.
 *
 * 5. **Subscriber snapshot consistency** — folded INTO `EmitIfChanged`
 *    (v5+). At every publish site inside
 *    `_internal/presence-emit.ts`, `new Set(...)` snapshots the live
 *    subscriber registry BEFORE fan-out iterates.
 *
 * 6. **Sink construction is unreachable from this module (v6 / codex
 *    r5 P2 #2).** The sink lives behind `createEmitIfChanged`'s
 *    closure in `_internal/presence-emit.ts`; this module imports
 *    only the factory + the curried capability type. Calling
 *    `createEmitIfChanged({ connections: deps.connections,
 *    subscribers: deps.subscribers })` inside the factory body
 *    produces the {@link EmitIfChanged} value; transition methods
 *    receive that value as their emit capability.
 *
 * 6.1. **Structural seal across both axes** — combined with the
 *    external-import seal (three `@ts-expect-error` canary lines at
 *    `presence-projection.types-check.ts` assert
 *    `InternalPresenceEventSink`, `createInternalFanOutEventSink`,
 *    AND `emitPresenceTransition` are NOT importable from
 *    `_internal/presence-emit.ts`; v7 made the third canary a real
 *    TS2305 seal by relocating `emitPresenceTransition` to
 *    `presence-projection-types.ts`), the dedup rule is structurally
 *    enforced:
 *    - **External:** no module outside this directory can construct
 *      or hold a sink, AND no module can call the pure dedup helper
 *      via the `_internal/` path (the seal forces routing through
 *      the projection's re-export — single contract surface).
 *    - **In-module (projection):** the projection module cannot
 *      construct or hold a sink either (the sink + its factory are
 *      unreachable from `presence-projection.ts` because they live
 *      behind `createEmitIfChanged`'s closure in `_internal/`).
 *
 * 7. **First-writer-wins discipline** — the `Ref.modify` predicate
 *    matches `LeaseRegistry`'s own atomicity model. No second `Ref.get`
 *    + `Ref.update` pair; the predicate IS the linearization point.
 *
 * 8. **Defect channel deleted (v7 / codex r6 P2 #1 follow-on).**
 *    `PresenceProjectionDefect` + `catchProjectionDefect` are
 *    deleted because the only `reason`
 *    (`entry-status-size-mismatch`) is now structurally impossible.
 *    Impl-staff body returns `Effect.void` on every reachable path;
 *    unrelated programmer defects propagate up through the fiber
 *    supervisor naturally.
 */
/** Outcome of a lifecycle CAS predicate (connect / disconnect). */
interface LifecycleOutcome {
  readonly prevStatus: DerivedPresenceStatus;
  readonly nextStatus: DerivedPresenceStatus;
}

/** Outcome of a lease-observer CAS predicate (begin / end). */
type ObserverOutcome =
  | { readonly _tag: "audit"; readonly event: PresenceProjectionAuditEvent }
  | {
      readonly _tag: "transition";
      readonly prevStatus: DerivedPresenceStatus;
      readonly nextStatus: DerivedPresenceStatus;
    };

type EntryMap = ReadonlyMap<AgentId, AgentPresenceEntry>;

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
 * Pure predicate for {@link PresenceProjection.onAgentConnect}.
 * Multi-connection-shaped (round-5 codex P2 fix): a second
 * simultaneous WebSocket connection ADDS to `liveConns` rather than
 * replacing it. Status changes only if the agent was previously
 * offline (`entry === undefined`); subsequent additions to an
 * already-tracked agent leave the active-lease set untouched.
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
    // Idempotent — already tracked. No-op.
    const status = deriveEntryStatus(entry);
    return [{ prevStatus: status, nextStatus: status }, entries];
  }
  // Additional simultaneous connection. Add to `liveConns`; leave
  // `leasesByConn` untouched. Status is whatever the existing leases
  // already imply.
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
 * Pure predicate for {@link PresenceProjection.onAgentDisconnect}.
 * Multi-connection-shaped (round-5 codex P2 fix): removes the
 * `connId` from `liveConns` and drops the per-conn lease bucket so
 * leases bound to the dead conn stop counting toward `working`. If
 * `liveConns` empties out, the entry is removed and status becomes
 * `offline`; otherwise the entry stays, and status is re-derived
 * from the remaining leases on the surviving connections.
 *
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

interface ObserverCallback {
  readonly kind: "begin" | "end";
  readonly leaseId: LeaseId;
  readonly recipientAgentId: AgentId;
  readonly recipientConnId: ConnectionId;
}

function auditAbsentEntry(cb: ObserverCallback): PresenceProjectionAuditEvent {
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
): PresenceProjectionAuditEvent {
  // Multi-conn fix: report the FIRST live connection as the "current"
  // for diagnostic purposes. Iteration order is insertion order in
  // ES Map/Set, which gives a stable witness when the agent has
  // multiple live connections.
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
 * Pure predicate for lease-observer transitions (begin / end).
 * Multi-connection-shaped (round-5 codex P2 fix): the
 * `recipientConnId` must be one of the agent's `liveConns`,
 * otherwise the callback is a fast-reconnect-race ghost and audits.
 * The lease is added to / removed from the per-conn bucket
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

function applyObserverOutcome(
  outcome: ObserverOutcome,
  recipientAgentId: AgentId,
  emit: EmitIfChanged,
): Effect.Effect<void, never, never> {
  if (outcome._tag === "audit") {
    return Effect.logDebug("presence projection audit", outcome.event);
  }
  return emit(outcome.prevStatus, outcome.nextStatus, recipientAgentId);
}

function statusForAgent(
  entries: EntryMap,
  agentId: AgentId,
): DerivedPresenceStatus {
  const entry = entries.get(agentId);
  return entry === undefined ? "offline" : deriveEntryStatus(entry);
}

function makeLifecycleMethods(
  entriesRef: Ref.Ref<EntryMap>,
  emit: EmitIfChanged,
): Pick<PresenceProjection, "onAgentConnect" | "onAgentDisconnect"> {
  const onAgentConnect: PresenceProjection["onAgentConnect"] = (
    agentId,
    connId,
  ) =>
    Ref.modify(entriesRef, (entries) =>
      computeConnectTransition(entries, agentId, connId),
    ).pipe(Effect.flatMap((o) => emit(o.prevStatus, o.nextStatus, agentId)));

  const onAgentDisconnect: PresenceProjection["onAgentDisconnect"] = (
    agentId,
    connId,
  ) =>
    Ref.modify(entriesRef, (entries) =>
      computeDisconnectTransition(entries, agentId, connId),
    ).pipe(Effect.flatMap((o) => emit(o.prevStatus, o.nextStatus, agentId)));

  return { onAgentConnect, onAgentDisconnect };
}

function makeObserverMethods(
  entriesRef: Ref.Ref<EntryMap>,
  emit: EmitIfChanged,
): Pick<PresenceProjection, "onLeaseActiveBegin" | "onLeaseActiveEnd"> {
  const handleObserverTransition = (
    cb: ObserverCallback,
  ): Effect.Effect<void, never, never> =>
    Ref.modify(entriesRef, (entries) =>
      computeObserverTransition(entries, cb),
    ).pipe(
      Effect.flatMap((outcome) =>
        applyObserverOutcome(outcome, cb.recipientAgentId, emit),
      ),
    );

  const onLeaseActiveBegin: PresenceProjection["onLeaseActiveBegin"] = (
    leaseId,
    recipientAgentId,
    recipientConnId,
  ) =>
    handleObserverTransition({
      kind: "begin",
      leaseId,
      recipientAgentId,
      recipientConnId,
    });

  const onLeaseActiveEnd: PresenceProjection["onLeaseActiveEnd"] = (
    leaseId,
    recipientAgentId,
    recipientConnId,
  ) =>
    handleObserverTransition({
      kind: "end",
      leaseId,
      recipientAgentId,
      recipientConnId,
    });

  return { onLeaseActiveBegin, onLeaseActiveEnd };
}

function makeStatusReaders(
  entriesRef: Ref.Ref<EntryMap>,
): Pick<PresenceProjection, "statusOf" | "statusMany"> {
  const statusOf: PresenceProjection["statusOf"] = (agentId) =>
    Ref.get(entriesRef).pipe(
      Effect.map((entries) => statusForAgent(entries, agentId)),
    );

  const statusMany: PresenceProjection["statusMany"] = (agentIds) =>
    Ref.get(entriesRef).pipe(
      Effect.map((entries) =>
        agentIds.map((agentId) => ({
          agentId,
          status: statusForAgent(entries, agentId),
        })),
      ),
    );

  return { statusOf, statusMany };
}

function buildProjection(
  entriesRef: Ref.Ref<EntryMap>,
  emit: EmitIfChanged,
): PresenceProjection {
  return {
    ...makeLifecycleMethods(entriesRef, emit),
    ...makeObserverMethods(entriesRef, emit),
    ...makeStatusReaders(entriesRef),
  };
}

export function makePresenceProjection(
  deps: PresenceProjectionDeps,
): Effect.Effect<PresenceProjection, never, never> {
  return Effect.gen(function* () {
    const entriesRef = yield* Ref.make<EntryMap>(new Map());
    const emit: EmitIfChanged = createEmitIfChanged({
      connections: deps.connections,
      subscribers: deps.subscribers,
    });
    return buildProjection(entriesRef, emit);
  }).pipe(Effect.withSpan("makePresenceProjection"));
}

/**
 * Effect Context tag for {@link PresenceProjection} (architect plan
 * #706 v6, codex r5 P2 #3).
 *
 * Promoted from impl-staff scope (v5) to architect tier in v6 because
 * the Tag IS the integration-boundary contract: every consumer that
 * wants to read presence status (`presence/subscribe` handler) or
 * call into a lifecycle method (`buildHelloOk`, `closeSocketSession`)
 * MUST yield this Tag in its R channel. Stubbing the Tag on the
 * architect branch lets the integration canary
 * (`presence-projection-integration.types-check.ts`) assert the Tag
 * exists with the right shape.
 *
 * Wired at composition root in `app/layers.ts` via
 * {@link PresenceProjectionLive}; impl-staff replaces the placeholder
 * factory body in §8 cutover.
 */
export class PresenceProjectionTag extends Context.Tag(
  "moltzap/PresenceProjection",
)<PresenceProjectionTag, PresenceProjection>() {}

// PresenceProjectionLive — declared in `app/layers.ts` (v7 / codex
// r6 P2 #3).
//
// v6 declared the Layer here via `export declare const
// PresenceProjectionLive: Layer.Layer<PresenceProjectionTag, never,
// unknown>` — a TYPE-only declaration with no runtime binding. Codex
// r6 P2 #3 caught the runtime gap: any consumer importing the
// placeholder would get `undefined` and crash. v7 relocates the
// Layer to `app/layers.ts` (cycle-friendly: that file already
// imports from this module), where it is bound to a real
// `Layer.die("PresenceProjectionLive: not implemented")` value with
// the typed `R` channel narrowed to `PresenceServiceTag |
// ConnectionManagerTag` (the deps `makePresenceProjection` will
// consume once impl-staff fills the body). The Layer is exported
// from `app/layers.ts` and consumed by `LeaseRegistryLive` for its
// `transitionObserver` field — the architect-branch wiring
// integration canary asserts that consumption (see
// `presence-projection-integration.types-check.ts`).
//
// The Tag (PresenceProjectionTag above) stays declared in THIS file
// — the Tag IS the architect contract surface. The Layer that
// constructs the value lives next to the other Live layers in
// `app/layers.ts`.
// (PresenceProjectionLive declaration moved to app/layers.ts)
