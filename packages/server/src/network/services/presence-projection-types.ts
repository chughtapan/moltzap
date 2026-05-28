/* eslint-disable jsdoc/text-escaping -- the canary doc literally cites `Effect<void, never, never>` as a type expression in prose; escaping the angle brackets would render them as escape codes in rendered docs. */

/**
 * Shared types for the presence-projection surface (architect plan
 * #706 v6).
 *
 * Extracted to a separate file so `_internal/presence-emit.ts` can
 * import the type primitives without pulling in
 * `presence-projection.ts` (which itself imports
 * `_internal/presence-emit.ts` for `EmitIfChanged` +
 * `createEmitIfChanged`). The split breaks the circular dependency
 * v6 introduced when relocating the raw sink + factory into
 * `_internal/` (codex r5 P2 #2 fix).
 *
 * `presence-projection.ts` re-exports `DerivedPresenceStatus`,
 * `PresenceSubscriberRegistry`, `AgentPresenceEntry`, and
 * `PresenceEmission` as the architect contract surface — callers
 * should import from `./presence-projection.js`, not from this file.
 * The architect names this file to satisfy the canary's
 * `@ts-expect-error` seal but does not include it in the public
 * contract.
 */

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
 * Invariant: every entry's `status` is either `"online"` or
 * `"working"`. `"offline"` is represented by entry absence.
 *
 * **v6 (codex r5 P2 #1):** entries additionally carry
 * `connId: ConnectionId` so the projection can detect lease callbacks
 * that arrive from a now-stale connection (fast-reconnect race). The
 * entry-creation invariant guarantees the field reflects the current
 * connection: only `onAgentConnect(agentId, connId)` allocates an
 * entry, and `onAgentDisconnect(agentId, connId)` only drops the
 * entry IF its `connId` matches (else the agent has already
 * reconnected on a new `connId` and the disconnect is for an old
 * session — silent no-op).
 */
export interface AgentPresenceEntry {
  readonly connId: ConnectionId;
  readonly activeLeases: ReadonlySet<LeaseId>;
  readonly status: Exclude<DerivedPresenceStatus, "offline">;
}
