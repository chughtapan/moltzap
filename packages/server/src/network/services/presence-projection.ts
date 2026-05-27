/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
/* eslint-disable sonarjs/void-use -- stubs `void X;` parameter to keep the public signature stable until impl-staff fills the body. */
import { Data, type Effect, type Option } from "effect";

import type { AgentId } from "@moltzap/protocol/identity";
import type { LeaseId } from "@moltzap/protocol";
import type { ConnectionId } from "@moltzap/protocol/network";

import type { ConnectionManager } from "../../transport/connection.js";

/**
 * Derived presence status — three-state set after #706's lease-derivation
 * rewrite. Replaces the prior `"online" | "offline" | "away"` set.
 *
 * - `online`   — connected, no active lease.
 * - `working`  — connected, ≥1 lease in GRANTED or CLAIMED.
 * - `offline`  — WS closed (no entry in projection state).
 *
 * `away` is gone. `working` IS the new third state.
 *
 * Implement-staff narrows `@moltzap/protocol/network/methods →
 * PresenceStatusEnum` to match this union. The legacy `PresenceStatus`
 * type in `presence-event-sink.ts` (currently
 * `"online" | "offline" | "away"`) is subsumed into this type when
 * `presence-event-sink.ts` is deleted in the §8 cutover and its sink
 * type migrates into this module as an unexported symbol — see
 * {@link InternalPresenceEventSink} for the structural-sealing
 * rationale.
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
 *
 * Impl-staff: declared in this module (`presence-projection.ts`) and
 * also re-exported by `task/leases/lease-registry.ts` as the default
 * for its dep field — so the lease-registry's CLAUDE-readable
 * documentation has the symbol in scope without forcing a cross-module
 * import in every test file.
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
 * Note: this function is the algebraic dedup rule. The structural gate
 * is the TS-module sealing of the emission sink — see
 * {@link InternalPresenceEventSink}. Both layers are load-bearing.
 */
export function emitPresenceTransition(
  previous: DerivedPresenceStatus,
  next: DerivedPresenceStatus,
): Option.Option<DerivedPresenceStatus> {
  void previous;
  void next;
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- architect stub body per SKILL.md "every stub body is exactly `throw new Error("not implemented")`"
  throw new Error("not implemented");
}

/**
 * Pure read interface the projection needs from `PresenceService` —
 * subscriber lookup. The projection consumes this rather than the full
 * `PresenceService` so the capability split (see
 * {@link InternalPresenceEventSink}) stays clean.
 *
 * Snapshot rule: every read at the projection's emission site MUST
 * snapshot the result via `new Set(...)` BEFORE iterating, so concurrent
 * `subscribe` / `removeConnection` mutations against the live registry
 * cannot leak into the fan-out (matches the pre-existing service
 * snapshot discipline at `presence.service.ts → transition`,
 * `new Set(this.getSubscribers(agentId))`). See §5 of the architect
 * plan for the linearization argument.
 */
export interface PresenceSubscriberRegistry {
  readonly getSubscribers: (agentId: AgentId) => ReadonlySet<ConnectionId>;
}

/**
 * **TS-module-sealed emission capability — architect plan §3.**
 *
 * The structural gate that makes every `presence/changed` wire emission
 * pass through the projection is THIS module's TS-level visibility
 * rules. The sink interface is **unexported** (`InternalPresenceEventSink`
 * has no `export` modifier). The fan-out factory
 * ({@link createInternalFanOutEventSink}) is **unexported**.
 * Any non-projection module attempting
 *
 *     import { InternalPresenceEventSink } from "./presence-projection.js";
 *
 * fails at TypeScript level with `Module './presence-projection.js' has
 * no exported member 'InternalPresenceEventSink'`. The compiler is
 * the structural gate.
 *
 * Why this design over v2's "alias an exported PresenceEventSink":
 * codex r2 P2 #4 caught that v2's `PresenceProjectionEmitSink = PresenceEventSink`
 * alias was a cosmetic split — the underlying type + factory remained
 * publicly importable from `presence-event-sink.ts`, so any module
 * holding `ConnectionManagerTag` could synthesize a sink and emit a
 * `presence/changed` frame outside the projection. v3 closes that
 * by physically co-locating the sink inside `presence-projection.ts`
 * and dropping `presence-event-sink.ts` entirely (impl-staff cutover
 * — see §8). Mirrors the v13 D-plan `mintLiveConnection` co-location
 * pattern.
 *
 * Composition: `PresenceProjectionLive` (in `app/layers.ts`)
 * constructs the sink via {@link createInternalFanOutEventSink}
 * inline — no Tag, no public re-export, no second consumer. The
 * sink value lives only inside the projection's closure.
 *
 * Public API: callers outside this module obtain status via
 * {@link PresenceProjection.statusOf} / {@link PresenceProjection.statusMany};
 * status MUTATION is the projection's monopoly (driven by
 * {@link LeaseTransitionObserver} from `LeaseRegistry` + WS-lifecycle
 * hooks {@link PresenceProjection.onAgentConnect} /
 * {@link PresenceProjection.onAgentDisconnect}).
 *
 * Impl-staff: the `Internal*` prefix is the naming convention this
 * module uses to mark "do not export"; the same prefix appears on
 * {@link createInternalFanOutEventSink}. Adding the
 * `export` keyword in front of either symbol is a P0-blocker review
 * finding — the sealing IS the contract.
 */
interface InternalPresenceEventSink {
  publish(input: {
    readonly agentId: AgentId;
    readonly status: DerivedPresenceStatus;
    readonly subscriberConnIds: ReadonlySet<ConnectionId>;
    readonly excludeConnId?: ConnectionId;
  }): void;
}

/**
 * Unexported fan-out sink factory (architect plan §3 + §8).
 *
 * Constructs the per-connection `presence/changed` fan-out sink used
 * by {@link makePresenceProjection}. The factory replaces the v2
 * `createConnectionFanOutPresenceEventSink` exported from
 * `presence-event-sink.ts`; in the §8 cutover, impl-staff deletes
 * `presence-event-sink.ts` (and its test) and moves the body of this
 * factory inline into THIS module.
 *
 * The factory takes `ConnectionManager` (already a Tag-discoverable
 * service in the server runtime) and produces a fire-and-forget sink:
 * write failures are logged and dropped; disconnect races MUST NOT
 * block the mutator.
 *
 * Visibility: unexported. The only call site is inside
 * {@link makePresenceProjection}'s factory body
 * (`PresenceProjectionLive` constructs the projection, which constructs
 * the sink). Adding `export` is a P0 review-blocker.
 */
function createInternalFanOutEventSink(deps: {
  readonly connections: ConnectionManager;
}): InternalPresenceEventSink {
  void deps;
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- architect stub body per SKILL.md "every stub body is exactly `throw new Error("not implemented")`"
  throw new Error("not implemented");
}

/**
 * Constructor inputs for {@link makePresenceProjection}.
 *
 * Two deps:
 *
 * - `subscribers` — read-only access to the subscriber registry (which
 *   conn ids care about which agent id). Sourced from `PresenceService`
 *   (the surviving non-mutating portion). The projection snapshots the
 *   read into a new `Set` before iterating at the emission site
 *   (`new Set(deps.subscribers.getSubscribers(agentId))`).
 * - `connections` — `ConnectionManager` from Tier 1. Passed through
 *   to {@link createInternalFanOutEventSink} inside the
 *   factory body so the sink can write per-connection
 *   `presence/changed` frames. The factory NEVER takes a sink as a
 *   dep — taking a sink would re-open the capability hole codex P2 #4
 *   identified. The sink is constructed inside the factory closure
 *   from `connections`, full stop.
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
 * Per-agent projection entry. The shape is a `Set<LeaseId>`, NOT a
 * counter, for two reasons:
 *
 * 1. **Idempotent removal.** A spurious double `onLeaseActiveEnd` for
 *    the same lease id is a no-op against a set (`set.delete(id)` on
 *    an absent id returns false); a counter would drift into negative
 *    territory or wrongly stay positive. Set membership is the
 *    operational truth. The idempotent case is silent — see
 *    {@link PresenceProjectionAuditEvent} for the "expected during
 *    teardown" cases that DO surface as audit logs.
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
 * Audit-event taxonomy for "expected during teardown" lease callbacks.
 *
 * Refined per codex r2 P2 #2 + P2 #3. v2 used
 * `PresenceProjectionDefect.reason = "active-end-without-begin" |
 * "begin-on-offline-agent" | "unknown-agent-on-end"` for ALL three
 * cases; codex pointed out that two of those are normal WS-close
 * cleanup paths and logging them as invariant failures produces noisy
 * false alarms.
 *
 * v3 splits the cases:
 *
 * - **`LeaseEndAfterDisconnect`** — `onLeaseActiveEnd(leaseId, agentId)`
 *   fires for an agent whose entry was already dropped by
 *   `onAgentDisconnect`. EXPECTED: `closeSocketSession` runs
 *   `onAgentDisconnect` BEFORE `leaseRegistry.abandon(connId)`, and
 *   abandon synchronously fires `onLeaseActiveEnd` for every active
 *   lease bound to the connection. Not a defect; logged at debug.
 *
 * - **`LeaseBeginAfterDisconnect`** — `onLeaseActiveBegin(leaseId, agentId)`
 *   fires between `onAgentDisconnect` and `leaseRegistry.abandon`, when
 *   a concurrent `resolveLease(grant)` on a different connection's
 *   moderator verdict lands during the disconnect window. EXPECTED in
 *   the race described in §5; the entry-creation invariant
 *   (only `onAgentConnect` creates entries) means the begin is
 *   correctly dropped without re-creating a ghost entry. Not a defect;
 *   logged at debug.
 *
 * Idempotent set operations (double `onLeaseActiveEnd` for the same
 * lease id on an EXISTING agent entry) are silent — the set-delete
 * returns false, no audit, no emission, no defect. The audit class is
 * specifically for the disconnect-window race cases.
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
    };

/**
 * Invariant-violation marker, surfaced through `Effect.die(new
 * PresenceProjectionDefect(...))` at the projection's outer edge.
 *
 * Refined per codex r2 P2 #2 + P2 #3. v3 reserves this class for
 * **genuinely impossible** states — situations where the projection
 * has reached a configuration the spec asserts cannot happen. The
 * "expected during teardown" cases (lease callbacks after disconnect,
 * double end on an existing entry) are now {@link PresenceProjectionAuditEvent}
 * with debug-level logging; they do NOT type-leak as defects.
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
 * Impl-staff:
 *
 *   yield* Effect.die(new PresenceProjectionDefect({ agentId, reason }))
 *
 * — and at the projection's outer edge:
 *
 *   .pipe(Effect.catchAllDefect((d) => Effect.logError(d)), Effect.asVoid)
 *
 * `reason` enumerates the impossible-state cases the projection
 * actively asserts. The taxonomy is intentionally narrow; if you find
 * yourself adding a fourth reason in implementation, escalate to the
 * architect — most "unexpected" cases are
 * {@link PresenceProjectionAuditEvent}, not defects.
 *
 * Reasons:
 *
 * - `entry-status-size-mismatch` — `Ref<ReadonlyMap<AgentId,
 *   AgentPresenceEntry>>` returned an entry with
 *   `activeLeases.size > 0` but `status = "online"`, or
 *   `activeLeases.size === 0` but `status = "working"`. Impossible
 *   unless the Ref.modify predicate or a manual `Ref.set` violated
 *   the invariant in {@link AgentPresenceEntry}.
 * - `connect-against-active-entry` — `onAgentConnect` fired against
 *   an entry whose `activeLeases` is non-empty (would require a
 *   lease to have been observed BEFORE the connect, violating the
 *   entry-creation invariant). Impossible if the entry-creation
 *   rule + Ref.modify linearization both hold.
 */
export class PresenceProjectionDefect extends Data.TaggedError(
  "PresenceProjectionDefect",
)<{
  readonly agentId: AgentId;
  readonly reason:
    | "entry-status-size-mismatch"
    | "connect-against-active-entry";
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
 *   `LeaseRegistry`, defaults to {@link noopLeaseTransitionObserver}).
 *   The registry calls into these methods from its `resolveLease`,
 *   `finalizeClaim`, `expireLeaseFromTtl`, and `expireLeaseOnDisconnect`
 *   sites.
 *
 * - **Connection boundary** — `onAgentConnect` and `onAgentDisconnect`
 *   are called from the WS-lifecycle hooks. Currently those sites are:
 *
 *   - Connect: `packages/server/src/identity/handlers/connect.handlers.ts → buildHelloOk`
 *     (replaces the existing `presenceService.setOnline(ctx.agentId)` call).
 *   - Disconnect: `packages/server/src/app/socket-handler.ts → closeSocketSession`
 *     (replaces the existing `presenceService.setOffline(authCtx.agentId)` call).
 *
 * **Status read surface (codex r2 P2 #1 fix):** v2 left `PresenceService.get`
 * + `getMany` as the read surface for status snapshots. With status
 * truth migrating into the projection, that surface returned stale
 * data. v3 moves the read into the projection
 * ({@link statusOf} / {@link statusMany}). `PresenceService.get`
 * + `getMany` delete in the §8 cutover; the only consumer
 * (`presence.handlers.ts → presence/subscribe`) rewires to call
 * `presenceProjection.statusMany(visibleIds)` instead.
 *
 * **Entry-creation rule (load-bearing — covers the
 * concurrent-grant-during-disconnect race):** entries are created
 * EXCLUSIVELY in `onAgentConnect`. `onLeaseActiveBegin` on an unknown
 * agent NEVER allocates an entry; instead it emits a
 * {@link PresenceProjectionAuditEvent} of `_tag:
 * "LeaseBeginAfterDisconnect"` (logged at debug) and returns
 * `Effect.void`. Net result: if a moderator's verdict resolves a
 * lease for an agent whose WS has already closed (a real race window:
 * `closeSocketSession` runs `onAgentDisconnect` BEFORE
 * `leaseRegistry.abandon(connId)`, but a concurrent
 * `resolveLease(grant)` on a different connection may fire between
 * the two), the projection drops it on the floor. The subsequent
 * `leaseRegistry.abandon` `onLeaseActiveEnd` for the same agent ALSO
 * finds no entry and audits as `_tag: "LeaseEndAfterDisconnect"`,
 * also dropped.
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
 *   participant Sink as Sealed sink (InternalPresenceEventSink)
 *   participant Subs as Subscribers (WS clients)
 *
 *   LR->>PP: onLeaseActiveBegin(leaseId, agentId)
 *   PP->>PP: Ref.modify computes BOTH new entry AND emission decision in one CAS
 *   alt agent has entry
 *     PP->>PP: prev = entry.status<br>nextLeases = activeLeases ∪ {leaseId}<br>next = nextLeases.size > 0 ? "working" : "online"<br>decision = emitPresenceTransition(prev, next)
 *     alt decision = some(status)
 *       PP->>PP: snapshot = new Set(subscribers.getSubscribers(agentId))
 *       PP->>Sink: publish({ agentId, status, subscriberConnIds: snapshot })
 *       Sink->>Subs: presence/changed { agentId, status }
 *     else decision = none
 *       Note over PP: dedup — concurrent GRANTED, no fan-out
 *     end
 *   else agent has no entry (disconnected)
 *     Note over PP: audit LeaseBeginAfterDisconnect — Effect.logDebug, no emission
 *   end
 * ```
 *
 * Mirror flow for `onLeaseActiveEnd` (same dispatch — Ref.modify, then
 * Option-gated snapshot-then-publish; absent-entry case audits as
 * `LeaseEndAfterDisconnect`), `onAgentConnect` (creates entry from
 * absent; `online` is emitted iff the agent was not already tracked;
 * existing-entry case is idempotent no-op), and `onAgentDisconnect`
 * (drops entry; emits `offline` iff entry existed).
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
   * lands during the disconnect window — find no entry and emit
   * {@link PresenceProjectionAuditEvent} (logged at debug). The
   * `offline` emission is single-source.
   *
   * Public error channel is `never`.
   */
  readonly onAgentDisconnect: (
    agentId: AgentId,
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

/**
 * Construct the projection. One instance per server lifetime; wired
 * into `LeaseRegistryDeps.transitionObserver` at composition root
 * (`packages/server/src/app/layers.ts` — Tier 2.55, between Tier 2
 * (Presence + AgentEndpointResolver) and Tier 2.6 (LeaseRegistry); the
 * projection consumes `PresenceServiceTag` for the subscriber-registry
 * read interface plus `ConnectionManagerTag` for the
 * internally-constructed fan-out sink, and `LeaseRegistryLive` threads
 * the projection as its `transitionObserver`).
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
 *    it after a later commit.
 *
 *    Pseudocode (lifecycle path — `onAgentConnect` / `onAgentDisconnect`;
 *    returns `Option.none` for already-present / already-absent
 *    no-ops, NOT `Effect.die`):
 *
 *    ```
 *    const decision = yield* Ref.modify(entriesRef, (entries) => {
 *      const entry = entries.get(agentId);
 *      // onAgentConnect: insert if absent, else no-op
 *      // onAgentDisconnect: drop if present, else no-op
 *      const [nextEntries, prevStatus, nextStatus] = computeLifecycle(entries, entry);
 *      return [emitPresenceTransition(prevStatus, nextStatus), nextEntries];
 *    });
 *    yield* Option.match(decision, {
 *      onSome: (status) => Effect.sync(() => {
 *        const snapshot = new Set(deps.subscribers.getSubscribers(agentId));
 *        sink.publish({ agentId, status, subscriberConnIds: snapshot });
 *      }),
 *      onNone: () => Effect.void,
 *    });
 *    ```
 *
 *    Pseudocode (lease-observer path — `onLeaseActiveBegin` /
 *    `onLeaseActiveEnd`; absent-entry case emits an audit event, NOT
 *    a defect):
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
 *      const prev = entry.status;
 *      const nextLeases = computeLeaseSet(entry.activeLeases, leaseId); // ∪ or \
 *      const nextStatus = nextLeases.size > 0 ? "working" : "online";
 *      const nextEntry = { activeLeases: nextLeases, status: nextStatus };
 *      const decision = emitPresenceTransition(prev, nextStatus);
 *      return [
 *        { _tag: "emit", decision },
 *        setReadonlyMapValue(agentId, nextEntry)(entries),
 *      ];
 *    });
 *    yield* result._tag === "audit"
 *      ? Effect.logDebug("presence projection audit", result.event)
 *      : Option.match(result.decision, {
 *          onSome: (status) => Effect.sync(() => {
 *            const snapshot = new Set(deps.subscribers.getSubscribers(agentId));
 *            sink.publish({ agentId, status, subscriberConnIds: snapshot });
 *          }),
 *          onNone: () => Effect.void,
 *        });
 *    ```
 *
 * 3. **Entry-creation invariant** — only `onAgentConnect` creates
 *    entries. `onLeaseActiveBegin`/`onLeaseActiveEnd` on an unknown
 *    agent emit {@link PresenceProjectionAuditEvent} (logged at
 *    debug), NOT {@link PresenceProjectionDefect}. The defect class
 *    is reserved for genuinely impossible states (see its JSDoc).
 *
 * 4. **Concurrent-grant-during-disconnect race** — combined with (3),
 *    if a `resolveLease(grant)` for `agentId=X` lands between
 *    `onAgentDisconnect(X)` and `leaseRegistry.abandon(connId)`, the
 *    grant's `onLeaseActiveBegin(X)` finds no entry → audit log →
 *    drop. No ghost `working` emission. The single `offline` from
 *    `onAgentDisconnect` is canonical.
 *
 * 5. **Subscriber snapshot consistency** — at every publish site,
 *    `new Set(deps.subscribers.getSubscribers(agentId))` snapshots
 *    the live subscriber registry BEFORE fan-out iterates. Concurrent
 *    `subscribe` / `removeConnection` calls against the registry cannot
 *    leak into the iteration. Matches the pre-existing snapshot
 *    discipline in `presence.service.ts → transition`.
 *
 * 6. **Sink construction** — the sink is built inside this factory's
 *    body via `createInternalFanOutEventSink({
 *    connections: deps.connections })` and held in the projection's
 *    closure. The `Internal*`-prefixed symbol is **not** exported from this
 *    module; the compiler is the structural gate (see
 *    {@link InternalPresenceEventSink}).
 *
 * 7. **First-writer-wins discipline** — the `Ref.modify` predicate
 *    matches `LeaseRegistry`'s own atomicity model. No second `Ref.get`
 *    + `Ref.update` pair; the predicate IS the linearization point.
 */
export function makePresenceProjection(
  deps: PresenceProjectionDeps,
): Effect.Effect<PresenceProjection, never, never> {
  void deps;
  void createInternalFanOutEventSink;
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- architect stub body per SKILL.md "every stub body is exactly `throw new Error("not implemented")`"
  throw new Error("not implemented");
}
