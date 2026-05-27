/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
/* eslint-disable sonarjs/void-use -- stubs `void X;` parameter to keep the public signature stable until impl-staff fills the body. */
import { Data, Effect, Option } from "effect";

import type { AgentId } from "@moltzap/protocol/identity";
import type { LeaseId } from "@moltzap/protocol";

import type { PresenceService } from "./presence.service.js";

/**
 * Derived presence status — three-state set after #706's lease-derivation
 * rewrite. Replaces the prior `"online" | "offline" | "away"` set.
 *
 * - `online`   — connected, no active lease.
 * - `working`  — connected, ≥1 lease in GRANTED or CLAIMED.
 * - `offline`  — WS closed (no entry in projection state).
 *
 * `away` is gone (`PresenceStatusEnum` narrowed in
 * `@moltzap/protocol/network/methods`). `working` IS the new third state.
 */
export type DerivedPresenceStatus = "online" | "working" | "offline";

/**
 * Wire event computed from a lease transition. The projection's only
 * emission shape: every other lease transition produces `Option.none()`
 * via {@link emitPresenceTransition}.
 *
 * The implementer is encouraged to consume this through
 * `Option.match` in the projection so the no-op path is exhaustive at
 * the call site (Principle 4).
 */
export interface PresenceEmission {
  readonly agentId: AgentId;
  readonly status: DerivedPresenceStatus;
}

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
 */
export interface LeaseTransitionObserver {
  readonly onLeaseActiveBegin: (
    leaseId: LeaseId,
    recipientAgentId: AgentId,
  ) => Effect.Effect<void, never, never>;
  readonly onLeaseActiveEnd: (
    leaseId: LeaseId,
    recipientAgentId: AgentId,
  ) => Effect.Effect<void, never, never>;
}

/**
 * Emit decision for a single status transition.
 *
 * The dedup rule encoded structurally: emit iff `previous !== next`.
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
 */
export function emitPresenceTransition(
  previous: DerivedPresenceStatus,
  next: DerivedPresenceStatus,
): Option.Option<DerivedPresenceStatus> {
  void previous;
  void next;
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- architect stub; impl-staff replaces with the dedup body (Option.none when prev === next).
  throw new Error("not implemented");
}

/**
 * Constructor inputs for {@link makePresenceProjection}.
 *
 * `presenceService` is the wire-emission surface — the projection
 * decides WHEN to emit, the service owns the subscriber registry +
 * `presence/changed` fan-out (unchanged from before #706).
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
  readonly presenceService: PresenceService;
}

/**
 * Per-agent projection entry. The shape is a `Set<LeaseId>`, NOT a
 * counter, for two reasons:
 *
 * 1. **Idempotent removal.** A spurious double `onLeaseActiveEnd` for
 *    the same lease id is a no-op against a set (`set.delete(id)` on
 *    an absent id returns false); a counter would drift into negative
 *    territory or wrongly stay positive. Set membership is the
 *    operational truth.
 * 2. **Debuggable.** The set is grep-able — operators can ask "which
 *    leases are pinning this agent to `working`?" without spelunking
 *    through the lease registry. The memory cost (≈40 bytes per lease
 *    id × small N per agent) is negligible against an `agents` table
 *    that already carries multi-KB rows.
 *
 * `presenceService.get(agentId)` is NOT used as the source of truth —
 * the projection's `status` field is derived from `activeLeases.size`
 * and held inline so the emission decision in
 * {@link emitPresenceTransition} can read it without a second lookup.
 */
export interface AgentPresenceEntry {
  readonly activeLeases: ReadonlySet<LeaseId>;
  readonly status: Exclude<DerivedPresenceStatus, "offline">;
}

/**
 * Tagged error reserved for invariant-violation defects. The projection
 * MUST NOT raise this on hot paths — `LeaseTransitionObserver`'s public
 * `never` channel is enforced via internal `Effect.catchAllDefect →
 * Effect.logError → Effect.void` at the projection's outer edge.
 *
 * Carried in the type system as a marker for impl-staff to know which
 * shape to surface when wiring the projection's internal asserts.
 */
export class PresenceProjectionDefect extends Data.TaggedError(
  "PresenceProjectionDefect",
)<{
  readonly agentId: AgentId;
  readonly reason:
    | "active-end-without-begin"
    | "begin-on-offline-agent"
    | "unknown-agent-on-end";
}> {
  override get message(): string {
    return `presence projection defect for ${this.agentId}: ${this.reason}`;
  }
}

/**
 * Public surface of the presence projection.
 *
 * The projection observes two boundaries:
 *
 * - **Lease boundary** — implements {@link LeaseTransitionObserver};
 *   wired into `LeaseRegistryDeps.transitionObserver` (new dep on
 *   `LeaseRegistry`). The registry calls into these methods from its
 *   `resolveLease`, `finalizeClaim`, `expireLeaseFromTtl`, and
 *   `expireLeaseOnDisconnect` sites.
 *
 * - **Connection boundary** — `onAgentConnect` and `onAgentDisconnect`
 *   are called from the WS-lifecycle hooks. Currently those sites are:
 *
 *   - Connect: `packages/server/src/task/handlers/connect.handlers.ts → buildHelloOk`
 *     (replaces the existing `presenceService.setOnline(ctx.agentId)` call).
 *   - Disconnect: `packages/server/src/app/socket-handler.ts → closeSocketSession`
 *     (replaces the existing `presenceService.setOffline(authCtx.agentId)` call).
 *
 * WS-close behavior (Acceptance #4): drop the agent's entry
 * unconditionally and emit `offline` regardless of prior status.
 * Subsequent `LeaseRegistry.abandon(connId)` transitions for the same
 * agent find no entry in the projection and are no-ops — the offline
 * emission is single-source.
 *
 * Emission flow (the rule in code):
 *
 * ```mermaid
 * sequenceDiagram
 *   participant LR as LeaseRegistry
 *   participant PP as PresenceProjection
 *   participant PS as PresenceService
 *   participant Subs as Subscribers (WS clients)
 *
 *   LR->>PP: onLeaseActiveBegin(leaseId, agentId)
 *   PP->>PP: prev = entry.status<br>entry.activeLeases.add(leaseId)<br>next = activeLeases.size > 0 ? working : online
 *   PP->>PP: emitPresenceTransition(prev, next)
 *   alt some(status)
 *     PP->>PS: emit(agentId, status)
 *     PS->>Subs: presence/changed { agentId, status }
 *   else none
 *     Note over PP: dedup — concurrent GRANTED, no fan-out
 *   end
 * ```
 *
 * Mirror flow for `onLeaseActiveEnd`, `onAgentConnect`, and
 * `onAgentDisconnect`.
 */
export interface PresenceProjection extends LeaseTransitionObserver {
  /**
   * WS connect: initialize the agent's entry to `{ activeLeases:
   * ∅, status: "online" }` and emit `online`. Idempotent: a
   * reconnect on an agent that is still tracked is a no-op (the agent
   * was already `online` or `working`).
   *
   * Public error channel is `never` — this runs inside the connect
   * handler and MUST NOT block the connect path on emission failure.
   */
  readonly onAgentConnect: (
    agentId: AgentId,
  ) => Effect.Effect<void, never, never>;

  /**
   * WS disconnect: drop the agent's entry and emit `offline`
   * regardless of prior status. Called BEFORE
   * `LeaseRegistry.abandon(connId)` from the WS-close finalizer so
   * subsequent lease transitions for this agent find no entry and
   * elide their fan-out.
   *
   * Public error channel is `never`.
   */
  readonly onAgentDisconnect: (
    agentId: AgentId,
  ) => Effect.Effect<void, never, never>;

  /**
   * Test/observability hook — read the agent's current projected
   * status. Returns `"offline"` for an unknown agent. NOT used on the
   * emission hot path; the projection reads its own `Ref` internally.
   */
  readonly statusOf: (
    agentId: AgentId,
  ) => Effect.Effect<DerivedPresenceStatus, never, never>;
}

/**
 * Construct the projection. One instance per server lifetime; wired
 * into `LeaseRegistryDeps.transitionObserver` at composition root
 * (`packages/server/src/app/layers.ts → PresenceServiceLive` /
 * `LeaseRegistryLive`).
 *
 * Implementation contract (the bit impl-staff fills in):
 *
 * - State store: `Ref<ReadonlyMap<AgentId, AgentPresenceEntry>>`
 *   (in-memory; matches `LeaseRegistry`).
 * - All four observer methods (`onLeaseActiveBegin`,
 *   `onLeaseActiveEnd`, `onAgentConnect`, `onAgentDisconnect`) read
 *   the current entry, compute the prev/next status pair, call
 *   {@link emitPresenceTransition} for the dedup decision, and
 *   forward the `Some` arm to `presenceService.emit(agentId, status)`.
 * - The `Ref.modify` predicate returns the entry + the emission
 *   decision (`Option<DerivedPresenceStatus>`); the emission runs
 *   AFTER the predicate commits so the state change is visible to
 *   any concurrent reader before the wire frame fires — same
 *   first-writer-wins discipline as `LeaseRegistry`.
 */
export function makePresenceProjection(
  deps: PresenceProjectionDeps,
): Effect.Effect<PresenceProjection, never, never> {
  void deps;
  return Effect.dieMessage(
    "presence-projection: not implemented (architect stub)",
  );
}
