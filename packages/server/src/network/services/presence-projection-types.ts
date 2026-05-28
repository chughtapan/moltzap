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
 * Per-agent projection entry. The shape is a `Set<LeaseId>`, NOT a
 * counter:
 *
 * 1. **Idempotent removal.** A spurious double `onLeaseActiveEnd` for
 *    the same lease id is a no-op against a set; a counter would
 *    drift.
 * 2. **Debuggable.** The set is grep-able.
 *
 * **v7 (codex r6 P2 #1).** Status is NOT stored on the entry — it is
 * derived everywhere via {@link deriveEntryStatus} from
 * `activeLeases.size`. The v6-era `status: Exclude<DerivedPresenceStatus,
 * "offline">` field was redundant with the set: storing both allowed
 * them to disagree, which v6 surfaced as the `entry-status-size-mismatch`
 * defect reason. Removing the field eliminates the class of mismatch
 * by construction; both `PresenceProjectionDefect` and
 * `catchProjectionDefect` are deleted in v7 (the reason union became
 * empty — no genuinely-impossible state remains).
 *
 * **v6 (codex r5 P2 #1):** entries carry `connId: ConnectionId` so
 * the projection can detect lease callbacks that arrive from a
 * now-stale connection (fast-reconnect race). The entry-creation
 * invariant guarantees the field reflects the current connection:
 * only `onAgentConnect(agentId, connId)` allocates an entry, and
 * `onAgentDisconnect(agentId, connId)` only drops the entry IF its
 * `connId` matches (else the agent has already reconnected on a new
 * `connId` and the disconnect is for an old session — silent no-op).
 *
 * "offline" is represented by entry absence; the projection NEVER
 * holds an entry whose derived status is "offline".
 */
export interface AgentPresenceEntry {
  readonly connId: ConnectionId;
  readonly activeLeases: ReadonlySet<LeaseId>;
}

/**
 * Derive the projection status from an entry (v7 / codex r6 P2 #1).
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
 * `entry-status-size-mismatch` defect by construction).
 */
export function deriveEntryStatus(
  entry: AgentPresenceEntry,
): Exclude<DerivedPresenceStatus, "offline"> {
  return entry.activeLeases.size === 0 ? "online" : "working";
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
