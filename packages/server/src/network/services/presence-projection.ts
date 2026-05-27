/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
/* eslint-disable sonarjs/void-use -- stubs `void X;` parameter to keep the public signature stable until impl-staff fills the body. */
import { Data, Effect, Option } from "effect";

import type { AgentId } from "@moltzap/protocol/identity";
import type { LeaseId } from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";

import type { PresenceEventSink } from "./presence-event-sink.js";

/**
 * Derived presence status — three-state set after #706's lease-derivation
 * rewrite. Replaces the prior `"online" | "offline" | "away"` set.
 *
 * - `online`   — connected, no active lease.
 * - `working`  — connected, ≥1 lease in GRANTED or CLAIMED.
 * - `offline`  — WS closed (no entry in projection state).
 *
 * `away` is gone (`PresenceStatusEnum` narrowed in
 * `@moltzap/protocol/network/methods` and the matching narrowing in
 * `presence-event-sink.ts → PresenceStatus`). `working` IS the new
 * third state.
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
export const noopLeaseTransitionObserver: LeaseTransitionObserver = {
  onLeaseActiveBegin: () => Effect.void,
  onLeaseActiveEnd: () => Effect.void,
};

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
 *
 * Note: this function is the algebraic dedup rule, but it is NOT the
 * type-system gate that forces every emission through it. The
 * structural gate is the {@link PresenceProjectionEmitSink} dep — the
 * projection module is the only holder of an emission capability into
 * `presence/changed`, so all wire emissions originate inside the
 * projection and pass through this function on their way out. See
 * {@link PresenceProjectionEmitSink} for the capability-encapsulation
 * argument.
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
 * Pure read interface the projection needs from `PresenceService` —
 * subscriber lookup. The projection consumes this rather than the full
 * `PresenceService` so the capability split (see
 * {@link PresenceProjectionEmitSink}) stays clean: emission is via the
 * sink the projection itself holds; subscriber registry remains owned
 * by `PresenceService` (which loses every mutation method on this
 * cutover — see §3 of the architect plan).
 */
export interface PresenceSubscriberRegistry {
  readonly getSubscribers: (agentId: AgentId) => ReadonlySet<ConnectionId>;
}

/**
 * Capability the projection holds to fan a status change out onto the
 * wire. Encapsulated inside the projection module — there is no Tag
 * for this in the Effect Context, and no public re-export, so the
 * compiler rejects any call to `presenceEventSink.publish(...)`
 * outside this module. That makes the dedup gate structural, not
 * advisory: the only path from "I want to emit `presence/changed`" to
 * the wire is `PresenceProjection.<observer-or-lifecycle-method>` →
 * (Ref.modify computes emission decision) → (decision is `Some`) →
 * `emitPresenceTransition` truth table → `PresenceEventSink.publish`.
 *
 * Rationale: the v1 plan exposed a public `PresenceService.emit`. That
 * surface meant any holder of `PresenceService` (every RPC handler
 * after Tier 2) could synthesize a `presence/changed` frame that
 * bypassed the projection's dedup and state machine. Drop that
 * surface; route emission exclusively through the projection. The
 * `PresenceEventSink` carrier already existed (sink in
 * `presence-event-sink.ts`) — we keep it; we just move ownership from
 * `PresenceService` to `PresenceProjection`.
 *
 * Impl-staff: at composition root in `app/layers.ts`, the same
 * `createConnectionFanOutPresenceEventSink({ connections })` factory
 * value flows into the projection now. `PresenceService` no longer
 * takes a sink — it becomes a pure subscriber registry.
 */
export type PresenceProjectionEmitSink = PresenceEventSink;

/**
 * Constructor inputs for {@link makePresenceProjection}.
 *
 * Two deps:
 *
 * - `subscribers` — read-only access to the subscriber registry (which
 *   conn ids care about which agent id). Sourced from `PresenceService`
 *   (the surviving non-mutating portion). The projection passes the
 *   subscriber set into the sink at emit time.
 * - `eventSink` — sole emission capability (see
 *   {@link PresenceProjectionEmitSink}). The composition root wires the
 *   same fan-out sink that `PresenceService` previously held.
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
  readonly eventSink: PresenceProjectionEmitSink;
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
 * The projection's `status` field is derived from `activeLeases.size`
 * and held inline so the emission decision in
 * {@link emitPresenceTransition} can read it without a second lookup.
 *
 * Invariant: every entry's `status` is either `"online"` or
 * `"working"`. `"offline"` is represented by entry absence (see
 * {@link PresenceProjection.onAgentDisconnect}); the projection NEVER
 * holds a `{ status: "offline" }` entry.
 */
export interface AgentPresenceEntry {
  readonly activeLeases: ReadonlySet<LeaseId>;
  readonly status: Exclude<DerivedPresenceStatus, "offline">;
}

/**
 * Invariant-violation marker, surfaced through `Effect.die(new
 * PresenceProjectionDefect(...))` at the projection's outer edge.
 *
 * Why `Effect.die` (not `Effect.fail`): a `LeaseTransitionObserver`
 * declares `Effect<void, never, never>` — that `never` is a load-bearing
 * promise to `LeaseRegistry` that the projection cannot push errors
 * back through the lease mutator. `Data.TaggedError` is the right
 * shape for a typed `fail` channel, but here the channel is closed.
 * `Effect.die` carries the same tagged class as a defect: it surfaces
 * to the runtime supervisor (logged via `Effect.catchAllDefect →
 * Effect.logError → Effect.void` at the projection's outer edge), but
 * does NOT type-leak through `onLeaseActiveBegin`'s `never` E channel.
 *
 * The class extends `Data.TaggedError` purely for the structural
 * `_tag`-and-fields ergonomics (a discriminated `_tag` makes the
 * downstream log handler exhaustive over `reason`). Impl-staff:
 *
 *   yield* Effect.die(new PresenceProjectionDefect({ agentId, reason }))
 *
 * — and at the projection's outer edge:
 *
 *   .pipe(Effect.catchAllDefect((d) => Effect.logError(d)), Effect.asVoid)
 *
 * `reason` enumerates the three invariant violations the projection
 * actively asserts (see the `Effect.die` call sites in the
 * implementation contract on {@link makePresenceProjection}).
 */
export class PresenceProjectionDefect extends Data.TaggedError(
  "PresenceProjectionDefect",
)<{
  readonly agentId: AgentId;
  readonly reason:
    | "active-end-without-begin"
    | "active-begin-without-connect"
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
 *   - Connect: `packages/server/src/identity/handlers/connect.handlers.ts → buildHelloOk`
 *     (replaces the existing `presenceService.setOnline(ctx.agentId)` call).
 *   - Disconnect: `packages/server/src/app/socket-handler.ts → closeSocketSession`
 *     (replaces the existing `presenceService.setOffline(authCtx.agentId)` call).
 *
 * **Entry-creation rule (load-bearing invariant — covers the
 * concurrent-grant-during-disconnect race):** entries are created
 * EXCLUSIVELY in `onAgentConnect`. `onLeaseActiveBegin` on an unknown
 * agent NEVER allocates an entry; instead it surfaces
 * `PresenceProjectionDefect{ reason: "active-begin-without-connect" }`
 * via `Effect.die`, which the projection's outer-edge defect handler
 * logs and drops. Net result: if a moderator's verdict resolves a
 * lease for an agent whose WS has already closed (a real race window:
 * `closeSocketSession` runs `onAgentDisconnect` BEFORE
 * `leaseRegistry.abandon(connId)`, but a concurrent
 * `resolveLease(grant)` on a different connection's verdict may fire
 * between the two), the projection drops it on the floor — and the
 * subsequent `leaseRegistry.abandon` `onLeaseActiveEnd` for the same
 * agent ALSO finds no entry and is also dropped.
 *
 * The "always-emit-`offline`" rule for WS-close (Acceptance #4) lives
 * exclusively in `onAgentDisconnect`. Combined with the
 * never-recreate rule above, every disconnect produces exactly one
 * `offline` emission on the wire; concurrent lease transitions during
 * the disconnect window produce zero stale `online`/`working`
 * emissions.
 *
 * Emission flow (the rule in code):
 *
 * ```mermaid
 * sequenceDiagram
 *   participant LR as LeaseRegistry
 *   participant PP as PresenceProjection
 *   participant Sink as PresenceEventSink
 *   participant Subs as Subscribers (WS clients)
 *
 *   LR->>PP: onLeaseActiveBegin(leaseId, agentId)
 *   PP->>PP: Ref.modify computes BOTH new entry AND emission decision in one CAS
 *   alt agent has entry
 *     PP->>PP: prev = entry.status<br>nextLeases = activeLeases ∪ {leaseId}<br>next = nextLeases.size > 0 ? "working" : "online"<br>decision = emitPresenceTransition(prev, next)
 *     alt decision = some(status)
 *       PP->>Sink: publish({ agentId, status, subscriberConnIds })
 *       Sink->>Subs: presence/changed { agentId, status }
 *     else decision = none
 *       Note over PP: dedup — concurrent GRANTED, no fan-out
 *     end
 *   else agent has no entry (disconnected)
 *     Note over PP: Effect.die(PresenceProjectionDefect) — logged + dropped at outer edge
 *   end
 * ```
 *
 * Mirror flow for `onLeaseActiveEnd` (same dispatch — Ref.modify, then
 * Option-gated publish), `onAgentConnect` (creates entry from absent;
 * `online` is emitted iff the agent was not already tracked), and
 * `onAgentDisconnect` (drops entry; emits `offline` iff entry existed).
 */
export interface PresenceProjection extends LeaseTransitionObserver {
  /**
   * WS connect: initialize the agent's entry to `{ activeLeases:
   * ∅, status: "online" }` and emit `online`. Idempotent: a
   * reconnect on an agent that is still tracked is a no-op (the agent
   * was already `online` or `working`).
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
  ) => Effect.Effect<void, never, never>;

  /**
   * WS disconnect: drop the agent's entry and emit `offline`
   * regardless of prior status. Called BEFORE
   * `LeaseRegistry.abandon(connId)` from the WS-close finalizer.
   *
   * The pre-`abandon` ordering plus the entry-creation invariant
   * (only `onAgentConnect` creates entries) means subsequent lease
   * transitions for this agent — whether they come from
   * `leaseRegistry.abandon`'s synchronous fan-out OR from a
   * concurrent `resolveLease(grant)` on a moderator's verdict that
   * lands during the disconnect window — find no entry and are
   * dropped by the projection. The `offline` emission is single-source.
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
 * (`packages/server/src/app/layers.ts` — Tier 2.55, between Tier 2
 * (Presence + AgentEndpointResolver) and Tier 2.6 (LeaseRegistry); the
 * projection consumes `PresenceServiceTag` for the subscriber-registry
 * read interface plus the shared `PresenceEventSink` value, and
 * `LeaseRegistryLive` threads the projection as its
 * `transitionObserver`).
 *
 * **Implementation contract (the bit impl-staff fills in):**
 *
 * 1. **State store** — `Ref<ReadonlyMap<AgentId, AgentPresenceEntry>>`
 *    (in-memory; matches `LeaseRegistry`).
 *
 * 2. **One Ref.modify per transition, linearizing both state AND
 *    emission decision** — every observer/lifecycle method computes
 *    `(nextMap, Option<DerivedPresenceStatus>)` inside a single
 *    `Ref.modify` predicate, then publishes the `Option` on the `Some`
 *    arm AFTER the CAS commits. This is the linearization boundary
 *    codex r1 P2 #5 asked for: the state change and the emission
 *    decision share the same atomic step, so no concurrent transition
 *    can compute a stale decision against pre-commit state and publish
 *    it after a later commit. Pseudocode:
 *
 *    ```
 *    const decision = yield* Ref.modify(entriesRef, (entries) => {
 *      const entry = entries.get(agentId);
 *      if (!entry) return [Option.none(), entries]; // see (3)
 *      const prev = entry.status;
 *      const nextLeases = entry.activeLeases.union(...); // or .delete(...) for end
 *      const nextStatus = nextLeases.size > 0 ? "working" : "online";
 *      const next = { activeLeases: nextLeases, status: nextStatus };
 *      const decision = emitPresenceTransition(prev, nextStatus);
 *      return [decision, setReadonlyMapValue(agentId, next)(entries)];
 *    });
 *    yield* Option.match(decision, {
 *      onSome: (status) => Effect.sync(() =>
 *        deps.eventSink.publish({
 *          agentId,
 *          status,
 *          subscriberConnIds: deps.subscribers.getSubscribers(agentId),
 *        })),
 *      onNone: () => Effect.void,
 *    });
 *    ```
 *
 * 3. **Entry-creation invariant** — only `onAgentConnect` creates
 *    entries. `onLeaseActiveBegin`/`onLeaseActiveEnd` on an unknown
 *    agent (entry absent) fire `Effect.die(new PresenceProjectionDefect({
 *    agentId, reason: "active-begin-without-connect" | "unknown-agent-on-end"
 *    }))`. The outer-edge defect handler pipes
 *    `Effect.catchAllDefect → Effect.logError → Effect.asVoid` so the
 *    `never` error channel of the public observer surface is preserved.
 *
 * 4. **Concurrent-grant-during-disconnect race** — combined with (3),
 *    if a `resolveLease(grant)` for `agentId=X` lands between
 *    `onAgentDisconnect(X)` and `leaseRegistry.abandon(connId)`, the
 *    grant's `onLeaseActiveBegin(X)` finds no entry → defect → log →
 *    drop. No ghost `working` emission. The single `offline` from
 *    `onAgentDisconnect` is canonical.
 *
 * 5. **First-writer-wins discipline** — the `Ref.modify` predicate
 *    matches `LeaseRegistry`'s own atomicity model. No second `Ref.get`
 *    + `Ref.update` pair; the predicate IS the linearization point.
 */
export function makePresenceProjection(
  deps: PresenceProjectionDeps,
): Effect.Effect<PresenceProjection, never, never> {
  void deps;
  return Effect.dieMessage(
    "presence-projection: not implemented (architect stub)",
  );
}
