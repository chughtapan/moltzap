/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
/* eslint-disable sonarjs/void-use -- stubs `void X;` parameter to keep the public signature stable until impl-staff fills the body. */
import { Context, type Effect } from "effect";

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
 * **v6 (codex r5 P2 #1): `recipientConnId` parameter added.** The
 * fast-reconnect race — agent A disconnects on `connId-1`, the
 * disconnect handler drops A's projection entry, A reconnects fast on
 * `connId-2`, the projection re-creates A's entry, THEN the
 * `leaseRegistry.abandon(connId-1)` synchronously fires
 * `onLeaseActiveEnd` for each of A's old leases — would, pre-v6, see
 * A's NEW entry and mutate/emit against the new session. v6 threads
 * the lease's `binding.recipientConnectionId` through the callback so
 * the projection can compare against its current entry's `connId`;
 * mismatch produces a {@link PresenceProjectionAuditEvent} of
 * `_tag: "LeaseCallbackFromStaleConnection"` and the callback is a
 * silent no-op (no state mutation, no emission). The single `offline`
 * from the disconnect-on-`connId-1` stands; the new `online` from
 * the connect-on-`connId-2` stands; the stale lease callbacks
 * neither mutate nor emit.
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
  onLeaseActiveBegin: () => {
    // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- architect stub body per SKILL.md "every stub body is exactly `throw new Error("not implemented")`"
    throw new Error("not implemented");
  },
  onLeaseActiveEnd: () => {
    // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- architect stub body per SKILL.md "every stub body is exactly `throw new Error("not implemented")`"
    throw new Error("not implemented");
  },
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
 * - **`LeaseCallbackFromStaleConnection`** (v6 / codex r5 P2 #1) —
 *   `onLeaseActiveBegin` OR `onLeaseActiveEnd` fires with a
 *   `recipientConnId` that does NOT match the projection entry's
 *   current `connId`. EXPECTED in the fast-reconnect race: agent A
 *   disconnects on `connId-1`, A reconnects on `connId-2`, the
 *   projection's entry now carries `connId: connId-2`, and the
 *   pending `leaseRegistry.abandon(connId-1)` fires `onLeaseActiveEnd`
 *   for A's old leases — those callbacks carry `recipientConnId =
 *   connId-1`, which mismatches the entry. Not a defect; logged at
 *   debug. The callback is a silent no-op (no state mutation, no
 *   emission). The `kind` field discriminates begin-vs-end so
 *   operators can grep by callback type.
 *
 * Idempotent set operations (double `onLeaseActiveEnd` for the same
 * lease id on an EXISTING agent entry whose `connId` MATCHES) are
 * silent — the set-delete returns false, no audit, no emission, no
 * defect. The audit class is specifically for the disconnect-window
 * and fast-reconnect race cases.
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
 * **v6 (codex r5 P2 #1): WS-lifecycle methods carry `connId`.** Both
 * `onAgentConnect` and `onAgentDisconnect` take a `connId:
 * ConnectionId` second parameter so the projection can detect the
 * fast-reconnect race. `onAgentConnect(agentId, connId-2)` overwrites
 * an existing entry's `connId` to `connId-2`; `onAgentDisconnect(agentId,
 * connId-1)` only drops the entry IF its current `connId === connId-1`
 * (else the agent has already reconnected on a newer connection and
 * the disconnect is for the old session — silent no-op).
 *
 * **Status read surface (codex r2 P2 #1 fix):** `PresenceProjection.statusOf`
 * + `statusMany` migrate the read from `PresenceService.get`/`getMany`
 * (deleted in §8 cutover).
 *
 * **Entry-creation rule (load-bearing — covers the
 * concurrent-grant-during-disconnect race):** entries are created
 * EXCLUSIVELY in `onAgentConnect`. `onLeaseActiveBegin` on an unknown
 * agent NEVER allocates an entry; instead it emits a
 * {@link PresenceProjectionAuditEvent} of `_tag:
 * "LeaseBeginAfterDisconnect"` (logged at debug) and returns
 * `Effect.void`. Combined with the v6 connId-mismatch check, every
 * disconnect produces exactly one `offline` emission on the wire,
 * and stale lease callbacks across reconnect boundaries neither
 * mutate state nor emit.
 *
 * The "always-emit-`offline`" rule for WS-close (Acceptance #4) lives
 * exclusively in `onAgentDisconnect`. Combined with the
 * never-recreate rule and the v6 connId-match guard, every disconnect
 * produces exactly one `offline` emission on the wire; concurrent
 * lease transitions during the disconnect window produce zero stale
 * `online`/`working` emissions; fast reconnects produce a clean
 * `online` (from the new `onAgentConnect`) without ghost `working`
 * leaks from the old session's pending lease callbacks.
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
 *   alt agent has entry AND entry.connId === recipientConnId
 *     PP->>PP: prev = deriveEntryStatus(entry)<br>nextLeases = activeLeases ∪ {leaseId}<br>next = nextLeases.size > 0 ? "working" : "online"
 *     PP->>Emit: emit(prev, next, agentId)
 *     Emit-->>Emit: emitPresenceTransition(prev, next) — dedup
 *     alt decision = some(status)
 *       Emit-->>Emit: snapshot = new Set(subscribers.getSubscribers(agentId))
 *       Emit->>Subs: presence/changed { agentId, status }
 *     else decision = none
 *       Note over Emit: dedup — concurrent GRANTED, no fan-out
 *     end
 *   else entry exists but connId mismatches (v6 fast-reconnect race)
 *     Note over PP: audit LeaseCallbackFromStaleConnection — Effect.logDebug, no emission
 *   else agent has no entry (disconnected)
 *     Note over PP: audit LeaseBeginAfterDisconnect — Effect.logDebug, no emission
 *   end
 * ```
 *
 * Mirror flow for `onLeaseActiveEnd` (same dispatch — Ref.modify, then
 * Option-gated emit; absent-entry case audits as
 * `LeaseEndAfterDisconnect`; connId-mismatch case audits as
 * `LeaseCallbackFromStaleConnection`), `onAgentConnect` (creates entry
 * from absent OR overwrites connId on existing entry; `online` is
 * emitted iff the agent was not already tracked OR the prior entry's
 * status was `offline`), and `onAgentDisconnect` (drops entry IFF
 * `entry.connId === connId` arg; emits `offline` iff entry was
 * actually dropped).
 */
export interface PresenceProjection extends LeaseTransitionObserver {
  /**
   * WS connect: initialize the agent's entry to `{ connId,
   * activeLeases: ∅ }` and emit `online` (derived from the empty
   * set via `deriveEntryStatus`).
   *
   * **v6 (codex r5 P2 #1) — `connId` parameter.** Each entry now
   * carries the originating connection's `connId`. Reconnect-with-new-connId
   * overwrites the entry's `connId` (and clears `activeLeases` since
   * the new connection has no pending leases yet).
   *
   * **v7 (codex r6 P2 #1) — `status` field removed from the entry.**
   * The entry stores `{ connId, activeLeases }`; status is derived
   * via `deriveEntryStatus(entry) = entry.activeLeases.size === 0 ?
   * "online" : "working"` everywhere.
   *
   * **Redundant-connect is an idempotent no-op (v4 / codex r3 P2 #1
   * fix).** A second `onAgentConnect` against an existing entry WITH
   * THE SAME `connId` — regardless of whether the derived status is
   * `"online"` (empty active set) OR `"working"` (active set non-empty
   * from intervening lease grants) — produces no event, no log, no
   * defect, no audit event. The `network/connect` handler's
   * `if (conn.auth) { return yield* buildHelloOk(...) }` early-return
   * makes this reachable in normal operation.
   *
   * **Reconnect-with-new-connId (v6 — fast reconnect after fast
   * disconnect).** A second `onAgentConnect` against an existing
   * entry with a DIFFERENT `connId` overwrites the entry to
   * `{ connId: newConnId, activeLeases: ∅ }` — derived status
   * becomes `"online"`. The prior entry's `activeLeases` are
   * dropped (they belonged to the old connection;
   * `leaseRegistry.abandon(oldConnId)` will fire `onLeaseActiveEnd`
   * for them, those callbacks will mismatch the new entry's
   * `connId` and audit as `LeaseCallbackFromStaleConnection`).
   * Emission: `Some("online")` iff the prior derived status was
   * `"working"` (transition `working → online`); otherwise the
   * lifecycle path dedup-elides via
   * `emitPresenceTransition("online", "online") = none`.
   *
   * THIS is the only method that creates an entry. `onLeaseActiveBegin`
   * NEVER creates entries — see the entry-creation invariant in the
   * interface-level JSDoc above.
   *
   * Public error channel is `never` — this runs inside the connect
   * handler and MUST NOT block the connect path on emission failure.
   */
  readonly onAgentConnect: (
    agentId: AgentId,
    connId: ConnectionId,
  ) => Effect.Effect<void, never, never>;

  /**
   * WS disconnect: drop the agent's entry IFF the entry's `connId`
   * matches the `connId` arg, and emit `offline` iff the entry was
   * actually dropped (i.e. status was previously `online` or
   * `working`). Called BEFORE `LeaseRegistry.abandon(connId)` from
   * the WS-close finalizer.
   *
   * **v6 (codex r5 P2 #1) — connId-match guard.** If `entry.connId !==
   * connId`, the agent has already reconnected on a newer connection
   * and this disconnect is for an old session. Silent no-op: no state
   * mutation, no emission, no log. The newer connection's
   * `onAgentConnect` (which preceded this disconnect in
   * close-handler ordering) is the canonical state; THIS disconnect
   * is a stale shadow.
   *
   * The pre-`abandon` ordering plus the entry-creation invariant
   * (only `onAgentConnect` creates entries) plus the connId-match
   * guard means subsequent lease transitions for this agent — whether
   * they come from `leaseRegistry.abandon`'s synchronous fan-out OR
   * from a concurrent `resolveLease(grant)` on a moderator's verdict
   * that lands during the disconnect window — find no entry (audit
   * as `LeaseEndAfterDisconnect` / `LeaseBeginAfterDisconnect`) OR
   * find the new connection's entry (audit as
   * `LeaseCallbackFromStaleConnection` because their
   * `recipientConnId` matches the OLD connection's id, not the new
   * entry's). All three audit paths produce no emission. The
   * `offline` emission from THIS disconnect (when it actually fires)
   * is single-source.
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
 *    (in-memory; matches `LeaseRegistry`). Each entry now carries
 *    `connId: ConnectionId` per v6 (codex r5 P2 #1).
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
 *      // onAgentConnect: insert if absent, overwrite connId+clear leases if
 *      //                 existing entry has a different connId, else no-op
 *      //                 (same connId; redundant connect).
 *      // onAgentDisconnect: drop if entry.connId === connId, else no-op
 *      //                    (stale disconnect from an old session).
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
 *        const event: PresenceProjectionAuditEvent = {
 *          _tag: kind === "begin"
 *            ? "LeaseBeginAfterDisconnect"
 *            : "LeaseEndAfterDisconnect",
 *          agentId,
 *          leaseId,
 *        };
 *        return [{ _tag: "audit", event }, entries];
 *      }
 *      if (entry.connId !== recipientConnId) {
 *        // v6 (codex r5 P2 #1) — fast-reconnect race. The callback
 *        // belongs to a now-stale connection; the projection's entry
 *        // is for the NEW connection.
 *        const event: PresenceProjectionAuditEvent = {
 *          _tag: "LeaseCallbackFromStaleConnection",
 *          agentId,
 *          leaseId,
 *          kind,
 *          staleConnId: recipientConnId,
 *          currentConnId: entry.connId,
 *        };
 *        return [{ _tag: "audit", event }, entries];
 *      }
 *      // v7 (codex r6 P2 #1): status is DERIVED from set size, not stored
 *      // on the entry. `deriveEntryStatus(entry)` returns the size-derived
 *      // "online"|"working"; the new entry stores ONLY connId + nextLeases.
 *      const prev = deriveEntryStatus(entry);
 *      const nextLeases = computeLeaseSet(entry.activeLeases, leaseId); // ∪ or \
 *      const nextEntry = { connId: entry.connId, activeLeases: nextLeases };
 *      const next = deriveEntryStatus(nextEntry);
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
 *    entries (or overwrites an existing entry's `connId` on fast
 *    reconnect — see step 2 lifecycle pseudocode).
 *    `onLeaseActiveBegin`/`onLeaseActiveEnd` on an unknown agent OR
 *    on an agent whose `entry.connId !== recipientConnId` emit
 *    {@link PresenceProjectionAuditEvent} (logged at debug). v7
 *    deletes the `PresenceProjectionDefect` class entirely — the
 *    only remaining `reason` (`entry-status-size-mismatch`) is
 *    structurally impossible now that `entry.status` is derived
 *    from `set.size` rather than stored.
 *
 * 4. **Concurrent-grant-during-disconnect + fast-reconnect races** —
 *    closed by (3) plus the connId-match guard added in v6.
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
export function makePresenceProjection(
  deps: PresenceProjectionDeps,
): Effect.Effect<PresenceProjection, never, never> {
  void deps;
  // v6 (codex r5 P2 #2): keep `createEmitIfChanged` reachable from
  // the factory closure so the in-module seal helper is exercised
  // by the canary. Impl-staff calls `createEmitIfChanged({ connections:
  // deps.connections, subscribers: deps.subscribers })` once and
  // passes the returned `EmitIfChanged` to every transition-method
  // helper. The raw sink + sink-factory are not reachable from THIS
  // module — they live in `_internal/presence-emit.ts`'s private
  // scope.
  void createEmitIfChanged;
  // v7 (codex r6 P2 #1): `deriveEntryStatus` is the projection's
  // single source-of-truth helper for size-derived status. Keep it
  // reachable from the factory closure so the canary exercises it.
  void deriveEntryStatus;
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- architect stub body per SKILL.md "every stub body is exactly `throw new Error("not implemented")`"
  throw new Error("not implemented");
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
