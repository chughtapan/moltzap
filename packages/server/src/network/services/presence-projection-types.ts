/* eslint-disable jsdoc/text-escaping -- the canary doc literally cites `Effect<void, never, never>` as a type expression in prose; escaping the angle brackets would render them as escape codes in rendered docs. */

/**
 * Shared types + pure functions for the presence-projection surface
 * (architect plan #706 v6+).
 *
 * Lives in a separate file so both `presence-projection.ts` (architect
 * contract surface) and `_internal/presence-emit.ts` (module-private
 * emit layer) can import the primitives without a circular dependency.
 * `presence-projection.ts` re-exports the symbols defined here as the
 * architect contract surface — callers MUST import from
 * `./presence-projection.js`, not from this file.
 *
 * **v7 (codex r6 P2 #4 — three-canary seal).** v6 exported
 * `emitPresenceTransition` from `_internal/presence-emit.ts`, which
 * made the "three TS-module seal canaries" claim false (only two
 * canaries actually fired; `emitPresenceTransition` was importable
 * from `_internal/`). v7 moves `emitPresenceTransition` HERE
 * (`presence-projection-types.ts`) so both `_internal/presence-emit.ts`
 * AND `presence-projection.ts` can import it from a non-`_internal/`
 * path; the canary on `_internal/presence-emit.ts` then asserts
 * `emitPresenceTransition` is genuinely NOT exported from `_internal/`.
 * Three real canaries; no prose drift.
 *
 * **v7 (codex r6 P2 #1 — entry shape narrowed).**
 * `AgentPresenceEntry.status` deleted. Status is derived everywhere
 * via `deriveEntryStatus(entry) = entry.activeLeases.size === 0 ?
 * "online" : "working"` (also exported from here for the
 * `Ref.modify` predicates in `presence-projection.ts` + the
 * `EmitIfChanged` curry in `_internal/presence-emit.ts`). The deleted
 * `status` field eliminates the `entry-status-size-mismatch` defect
 * class (impossible by construction; deleted in v7), which in turn
 * deletes the `PresenceProjectionDefect` class entirely (the reason
 * union is now empty).
 */

import { Option } from "effect";

import type { AgentId } from "@moltzap/protocol/identity";
import type { LeaseId } from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";

/**
 * Derived presence status — three-state set after #706's lease-derivation
 * rewrite. Replaces the prior `"online" | "offline" | "away"` set.
 *
 * - `online`   — connected, no active lease.
 * - `working`  — connected, ≥1 lease in GRANTED or CLAIMED.
 * - `offline`  — WS closed (no entry in projection state).
 *
 * `away` is gone. `working` IS the new third state.
 */
export type DerivedPresenceStatus = "online" | "working" | "offline";

/**
 * Wire event computed from a lease transition. The projection's only
 * emission shape: every other lease transition produces `Option.none()`
 * via {@link emitPresenceTransition}.
 */
export interface PresenceEmission {
  readonly agentId: AgentId;
  readonly status: DerivedPresenceStatus;
}

/**
 * Pure read interface the projection needs from `PresenceService` —
 * subscriber lookup. The projection consumes this rather than the full
 * `PresenceService` so the capability split stays clean.
 *
 * Snapshot rule: every read at the projection's emission site MUST
 * snapshot the result via `new Set(...)` BEFORE iterating, so concurrent
 * `subscribe` / `removeConnection` mutations against the live registry
 * cannot leak into the fan-out.
 */
export interface PresenceSubscriberRegistry {
  readonly getSubscribers: (agentId: AgentId) => ReadonlySet<ConnectionId>;
}

/**
 * Per-agent projection entry. Multi-connection-shaped (round-5 codex
 * P2 fix): an agent may hold multiple simultaneous WebSocket
 * connections (web tab + CLI + mobile — see
 * `AgentEndpointResolver`'s module JSDoc), so the entry tracks the
 * full set of live connections + the active leases keyed by which
 * connection holds them.
 *
 * Two collections, one invariant:
 *
 * - `liveConns: ReadonlySet<ConnectionId>` — every WS connection the
 *   agent is currently authenticated on. Updated by
 *   `onAgentConnect` / `onAgentDisconnect`.
 * - `leasesByConn: ReadonlyMap<ConnectionId, ReadonlySet<LeaseId>>`
 *   — per-connection breakdown of active leases (GRANTED or CLAIMED).
 *   Updated by `onLeaseActiveBegin` / `onLeaseActiveEnd`. When a
 *   connection disconnects, its bucket is dropped wholesale so the
 *   leases bound to the dead conn don't keep the agent in `working`
 *   forever.
 *
 * Invariant: every key in `leasesByConn` MUST be present in
 * `liveConns`. The connId-mismatch audit
 * (`LeaseCallbackFromStaleConnection`) is exactly the case where a
 * lease callback arrives bound to a `recipientConnId` not in
 * `liveConns` — that callback is a fast-reconnect race ghost and
 * no-ops.
 *
 * Status derivation: total active lease count across all live
 * connections. `working` if any live connection holds at least one
 * active lease; `online` if the entry exists but holds no active
 * leases anywhere; `offline` if the entry is absent entirely. See
 * {@link deriveEntryStatus}.
 *
 * **History.** v6 (codex r5 P2 #1) introduced the single-`connId`
 * shape with a fast-reconnect-race audit; v7 (codex r6 P2 #1)
 * deleted the redundant `status` field. The single-`connId`
 * assumption was wrong about the server's actual model: round-5
 * codex PR review flagged that
 * a second simultaneous WebSocket connection (multi-tab, CLI +
 * mobile) was incorrectly treated as a reconnect, clearing the
 * agent's active leases and emitting a spurious `online`
 * notification while the agent was still busy on the first conn.
 * This entry shape carries both halves so the multi-connection case
 * is correctness-by-construction.
 *
 * "offline" is represented by entry absence; the projection NEVER
 * holds an entry whose derived status is "offline" (and never holds
 * an entry whose `liveConns` is empty).
 */
export interface AgentPresenceEntry {
  readonly liveConns: ReadonlySet<ConnectionId>;
  readonly leasesByConn: ReadonlyMap<ConnectionId, ReadonlySet<LeaseId>>;
}

/**
 * Derive the projection status from an entry (round-5 codex P2 fix:
 * total across all live connections).
 *
 * Single source of truth for the size-to-status mapping; called from:
 *
 * - The lifecycle/observer `Ref.modify` predicates in
 *   `presence-projection.ts` (computes `prev` and `next` from the
 *   old and new entries).
 * - Read methods `PresenceProjection.statusOf` / `statusMany`
 *   (returns the derived status without storing it).
 *
 * Replaces the v6 `entry.status` field (deleted to eliminate the
 * `entry-status-size-mismatch` defect by construction) and the v6
 * `activeLeases.size === 0 ? "online" : "working"` single-conn
 * derivation. The new rule walks `leasesByConn` and counts the
 * union of active leases across every live connection — any
 * non-zero count keeps the agent `working`.
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
 * Pure algebraic dedup rule (architect plan §3 / §5).
 *
 * **v7 (codex r6 P2 #4 — three-canary seal).** Relocated from
 * `_internal/presence-emit.ts` to here (`presence-projection-types.ts`)
 * so the `@ts-expect-error` canary on `_internal/presence-emit.ts`
 * for `emitPresenceTransition` is now a REAL TS2305 seal — the
 * function is no longer exported from `_internal/`. Both
 * `_internal/presence-emit.ts` (for the `EmitIfChanged` curry) and
 * `presence-projection.ts` (for the architect contract re-export)
 * import the function from THIS module instead.
 *
 * Truth table:
 *
 * | previous | next    | emit             |
 * |----------|---------|------------------|
 * | online   | online  | `none`           |
 * | online   | working | `some(working)`  |
 * | working  | working | `none` (dedup)   |
 * | working  | online  | `some(online)`   |
 * | online   | offline | `some(offline)`  |
 * | working  | offline | `some(offline)`  |
 * | offline  | *       | (call site never produces; offline is terminal until reconnect) |
 *
 * The two-arg discipline forces the projection to NAME the previous
 * status at the emission site, which is how concurrent GRANTED leases
 * stop producing duplicate `working` notifications: the second GRANT
 * sees `previous = working` and elides the emission.
 *
 * Note: this function is the algebraic dedup rule. The structural
 * gate is the TS-module sealing of the emission sink — see
 * `_internal/presence-emit.ts → InternalPresenceEventSink`. Both
 * layers are load-bearing.
 */
export function emitPresenceTransition(
  previous: DerivedPresenceStatus,
  next: DerivedPresenceStatus,
): Option.Option<DerivedPresenceStatus> {
  return previous === next ? Option.none() : Option.some(next);
}
