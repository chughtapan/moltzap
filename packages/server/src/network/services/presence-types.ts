/* eslint-disable jsdoc/text-escaping -- the JSDoc literally cites `Effect<void, never, never>` as a type expression in prose; escaping the angle brackets would render them as escape codes in rendered docs. */

import { Effect, Option } from "effect";

import type { AgentId } from "@moltzap/protocol/identity";
import type { LeaseId } from "@moltzap/protocol/message";
import type { ConnectionId } from "@moltzap/protocol/socket";

/**
 * Derived presence status. Three-state set:
 *
 * - `online`   — connected, no active lease.
 * - `working`  — connected, ≥1 lease in GRANTED or CLAIMED.
 * - `offline`  — WS closed (no entry in presence state).
 */
export type DerivedPresenceStatus = "online" | "working" | "offline";

/** Wire event computed from a presence transition. */
export interface PresenceEmission {
  readonly agentId: AgentId;
  readonly status: DerivedPresenceStatus;
}

/**
 * Per-agent presence entry. An agent may hold multiple simultaneous
 * WebSocket connections (web tab + CLI + mobile — see
 * `AgentEndpointResolver`'s module JSDoc), so the entry tracks the
 * full set of live connections + the active leases keyed by which
 * connection holds them.
 *
 * - `liveConns: ReadonlySet<ConnectionId>` — every WS connection the
 *   agent is currently authenticated on.
 * - `leasesByConn: ReadonlyMap<ConnectionId, ReadonlySet<LeaseId>>`
 *   — per-connection breakdown of active leases (GRANTED or CLAIMED).
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

/**
 * Derive presence status from an entry — total across all live
 * connections. Single source of truth for the lease-count-to-status
 * mapping; walks `leasesByConn` and returns `working` for any non-zero
 * count, else `online`.
 */
export function deriveEntryStatus(
  entry: AgentPresenceEntry,
): Exclude<DerivedPresenceStatus, "offline"> {
  for (const leases of entry.leasesByConn.values()) {
    if (leases.size > 0) return "working";
  }
  return "online";
}

/**
 * Pure algebraic dedup rule.
 *
 * | previous | next    | emit             |
 * |----------|---------|------------------|
 * | online   | online  | `none`           |
 * | online   | working | `some(working)`  |
 * | working  | working | `none` (dedup)   |
 * | working  | online  | `some(online)`   |
 * | online   | offline | `some(offline)`  |
 * | working  | offline | `some(offline)`  |
 *
 * The two-arg discipline forces the caller to NAME the previous status
 * at the emission site, which is how concurrent GRANTED leases stop
 * producing duplicate `working` notifications: the second GRANT sees
 * `previous = working` and elides the emission.
 */
export function dedupePresenceStatus(
  previous: DerivedPresenceStatus,
  next: DerivedPresenceStatus,
): Option.Option<DerivedPresenceStatus> {
  return previous === next ? Option.none() : Option.some(next);
}

/**
 * Audit-event taxonomy for "expected during teardown" lease callbacks.
 *
 * - **`LeaseEndAfterDisconnect`** — `onLeaseActiveEnd` fires for an
 *   agent whose entry was already dropped by `onAgentDisconnect`.
 *   `closeSocketSession` runs `onAgentDisconnect` BEFORE
 *   `leaseRegistry.abandon(connId)`, and abandon synchronously fires
 *   `onLeaseActiveEnd` for every active lease bound to the connection.
 *
 * - **`LeaseBeginAfterDisconnect`** — `onLeaseActiveBegin` fires
 *   between `onAgentDisconnect` and `leaseRegistry.abandon`, when a
 *   concurrent `resolveLease(grant)` on a different connection's
 *   moderator verdict lands during the disconnect window. The
 *   entry-creation invariant (only `onAgentConnect` creates entries)
 *   means the begin is correctly dropped without re-creating a ghost
 *   entry.
 *
 * - **`LeaseCallbackFromStaleConnection`** — a lease callback fires
 *   with a `recipientConnId` that is NOT in the entry's current
 *   `liveConns` set. The fast-reconnect race: agent A's `connId-1`
 *   disconnects (removed from `liveConns`), A reconnects on
 *   `connId-2`, and the pending `leaseRegistry.abandon(connId-1)`
 *   fires `onLeaseActiveEnd` for A's old leases carrying the now-stale
 *   `connId-1`. The callback is a silent no-op (no state mutation, no
 *   emission). `currentConnId` reports an arbitrary stable witness
 *   from `liveConns` (the first, insertion-ordered) for diagnostics.
 *
 * Idempotent set operations (double `onLeaseActiveEnd` for the same
 * lease id on an entry whose `recipientConnId` IS in `liveConns`) are
 * silent — no audit, no emission. The audit class is specifically for
 * the disconnect-window and fast-reconnect race cases.
 *
 * Audit events are emitted via `Effect.logDebug`. They do NOT go
 * through `Effect.die`; the `never` E channel is preserved by
 * construction.
 */
export type PresenceAuditEvent =
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
      /** A stable witness from the entry's current `liveConns`. */
      readonly currentConnId: ConnectionId;
    };

/**
 * Observer surface the `LeaseRegistry` calls at each transition
 * that crosses the lease's "active for presence" boundary. "Active"
 * means GRANTED or CLAIMED — the two states that count toward
 * `working`.
 *
 * This is the NARROW contract `LeaseRegistry` depends on. The registry
 * sees only these two methods, not the full `PresenceService` surface.
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
 * Public error channel is `never` — presence is best-effort and MUST
 * NOT propagate failure to the lease registry mutator.
 *
 * **`recipientConnId` parameter.** Threads the lease's
 * `binding.recipientConnectionId` so the service can check
 * `recipientConnId ∈ entry.liveConns` and drop fast-reconnect-race
 * ghost callbacks. The fast-reconnect race: agent A disconnects on
 * `connId-1`, the disconnect handler drops `connId-1` from A's
 * `liveConns`, A reconnects fast on `connId-2`, then the pending
 * `leaseRegistry.abandon(connId-1)` synchronously fires
 * `onLeaseActiveEnd` for each of A's old leases. Without connId
 * threading, those callbacks would mutate against the surviving
 * connection; the check makes them no-op audits instead.
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
 * Default observer used by `LeaseRegistry`'s `transitionObserver`
 * when the registry is constructed without a presence service (e.g. in
 * `lease-registry.test.ts` unit tests that do not exercise presence).
 *
 * The default discipline (Principle 4) is to have a value that does the
 * right thing rather than a `null` branch every call site has to
 * remember to guard.
 */
export const noopLeaseTransitionObserver: LeaseTransitionObserver = {
  onLeaseActiveBegin: () => Effect.void,
  onLeaseActiveEnd: () => Effect.void,
};
