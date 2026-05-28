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
 * In-module emit capability the projection's transition methods
 * receive INSTEAD of raw access to {@link InternalPresenceEventSink}
 * (architect plan #706 v5, codex r4 P2 #2).
 *
 * `(previous, next, agentId) => Effect<void, never, never>` — the
 * helper consults {@link emitPresenceTransition} for the dedup
 * decision, snapshots the subscriber set, and publishes through the
 * sink iff the decision is `Some`. The transition methods
 * (`onAgentConnect`, `onAgentDisconnect`, `onLeaseActiveBegin`,
 * `onLeaseActiveEnd`) NEVER receive or close over the raw
 * `sink.publish` — they only receive a value of THIS shape,
 * constructed once inside {@link makePresenceProjection}'s closure
 * via {@link createEmitIfChanged}.
 *
 * Why this design: the v3 TS-module seal closed the
 * external-import hole on `InternalPresenceEventSink`, but codex r4
 * P2 #2 pointed out that any in-module code (a future projection
 * method, a refactor that lifts a helper) could still call
 * `sink.publish(...)` directly and bypass {@link emitPresenceTransition}.
 * Routing every emission through `EmitIfChanged` makes the dedup
 * gate enforced at the IN-MODULE call-site level too: the only
 * value in the projection's closure that can call `sink.publish` is
 * the closed-over function `createEmitIfChanged` produces, and that
 * function checks the dedup `Option` first.
 *
 * The transition-method signatures (in the local helpers impl-staff
 * writes inside the factory body) take `EmitIfChanged` as a parameter
 * and the raw `InternalPresenceEventSink` is unreachable from them.
 * Combined with the external seal, the dedup rule is structurally
 * enforced across both axes: external callers cannot construct a
 * sink; in-module callers cannot bypass the helper.
 */
export type EmitIfChanged = (
  previous: DerivedPresenceStatus,
  next: DerivedPresenceStatus,
  agentId: AgentId,
) => Effect.Effect<void, never, never>;

/**
 * Unexported factory for {@link EmitIfChanged}. Closes over the raw
 * sink + subscriber registry so the only access path is the curried
 * dedup-gated function. The projection's transition methods take the
 * returned `EmitIfChanged` as their emit capability and never see
 * the sink at all.
 *
 * Recipe (impl-staff fills the body):
 *
 *     return (previous, next, agentId) =>
 *       Effect.sync(() => {
 *         const decision = emitPresenceTransition(previous, next);
 *         Option.match(decision, {
 *           onNone: () => undefined,
 *           onSome: (status) => {
 *             const subscriberConnIds = new Set(
 *               deps.subscribers.getSubscribers(agentId),
 *             );
 *             deps.sink.publish({ agentId, status, subscriberConnIds });
 *           },
 *         });
 *       });
 *
 * Visibility: unexported. The only construction site is inside
 * {@link makePresenceProjection}'s closure, just after the sink is
 * built via {@link createInternalFanOutEventSink}. The returned
 * `EmitIfChanged` is the value passed to every transition-method
 * helper.
 */
function createEmitIfChanged(deps: {
  readonly sink: InternalPresenceEventSink;
  readonly subscribers: PresenceSubscriberRegistry;
}): EmitIfChanged {
  // architect stub: each `void` reference exists to keep the named
  // parameters reachable from the type-canary even when impl-staff
  // hasn't filled in the body. `deps.sink` + `deps.subscribers` are
  // BOTH load-bearing here (the helper closes over both); naming
  // each individually distinguishes this stub from the sibling
  // `createInternalFanOutEventSink` stub (sonarjs/no-identical-functions).
  void deps.sink;
  void deps.subscribers;
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
 *
 * **v4 deletion (codex r3 P2 #1).** v3 carried a second reason,
 * `connect-against-active-entry`, on the premise that `onAgentConnect`
 * against an entry whose `activeLeases` was non-empty was impossible.
 * Codex r3 caught that this is in fact reachable in normal operation:
 * `network/connect` can run again on an already-authenticated
 * connection (the v3 plan itself describes the connect handler's
 * `if (conn.auth) { return yield* buildHelloOk(...) }` early-return),
 * which produces a second `onAgentConnect` against an existing entry —
 * possibly one whose status has already advanced to `"working"` due to
 * intervening lease grants. A redundant connect against an entry in
 * `online` OR `working` is now an idempotent no-op (no event, no log,
 * no defect, no audit event); see
 * {@link PresenceProjection.onAgentConnect} for the contract.
 */
export class PresenceProjectionDefect extends Data.TaggedError(
  "PresenceProjectionDefect",
)<{
  readonly agentId: AgentId;
  readonly reason: "entry-status-size-mismatch";
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
   * ∅, status: "online" }` and emit `online`.
   *
   * **Redundant-connect is an idempotent no-op (v4 / codex r3 P2 #1
   * fix).** A second `onAgentConnect` against an existing entry —
   * regardless of whether that entry's status is `"online"` (no
   * intervening lease) OR `"working"` (lease grants landed between
   * the first connect and this one) — produces no event, no log, no
   * defect, no audit event. The `network/connect` handler's
   * `if (conn.auth) { return yield* buildHelloOk(...) }` early-return
   * makes this reachable in normal operation, so v4 deleted the
   * `connect-against-active-entry` defect reason that v3 carried for
   * the `"working"`-entry branch. Net behavior: the projection's
   * `Ref.modify` predicate returns `Option.none()` whenever an entry
   * already exists, regardless of its status; the lifecycle path
   * publishes only on `Some`.
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
 * Defect-boundary wrapper (v4 / codex r3 P3 #2; narrowed v5 /
 * codex r4 P2 #3).
 *
 * Every public method on {@link PresenceProjection} —
 * `onAgentConnect`, `onAgentDisconnect`, `onLeaseActiveBegin`,
 * `onLeaseActiveEnd`, `statusOf`, `statusMany` — MUST run through
 * `catchProjectionDefect` so the `never` E channel is structurally
 * preserved.
 *
 * **v5 narrowing.** v4 used a bare `Effect.catchAllDefect`, which
 * swallowed ANY defect — including genuine programmer errors like
 * `TypeError: x is not a function` — as a presence fallback. Codex
 * r4 P2 #3 caught this: an unrelated runtime defect inside a
 * projection method would resolve as `"offline"` or `void` and the
 * underlying bug would never surface. v5 narrows the catch to
 * `PresenceProjectionDefect` instances ONLY; everything else is
 * re-died as a fresh defect for the outer fiber to handle.
 *
 * Behavior:
 *
 * - Defect IS a `PresenceProjectionDefect` (caught via
 *   `defect instanceof PresenceProjectionDefect`) — log via
 *   `Effect.logError("presence projection defect", { defect })` and
 *   resolve to `fallback`:
 *
 *   - Emit methods (`onAgentConnect`, `onAgentDisconnect`,
 *     `onLeaseActiveBegin`, `onLeaseActiveEnd`) — pass
 *     `undefined as void` as fallback so a defected emission is
 *     silently dropped on the wire side. The public Effect resolves
 *     with `void`; the WS handler / lease registry observe no
 *     failure.
 *   - Read methods (`statusOf`, `statusMany`) — substitute the
 *     "unknown-agent" fallback: `statusOf` passes
 *     `"offline" as DerivedPresenceStatus`; `statusMany` passes
 *     `agentIds.map((agentId) => ({ agentId, status: "offline" as const }))`.
 *     A defected read MUST NOT propagate through to
 *     `presence/subscribe`.
 *
 * - Defect is anything else — re-die via `Effect.die(defect)` so the
 *   outer fiber's supervisor handles it normally. The wrapper MUST
 *   NOT mask unrelated programmer/runtime defects as
 *   presence-shaped fallbacks (codex r4 P2 #3 root cause).
 *
 * Why a named wrapper: v3 said "caught at the projection's outer
 * edge" without naming a helper. Codex r3 P3 #2 pointed out impl-staff
 * would have to invent the pattern; naming the helper makes the
 * boundary load-bearing in the contract and reviewable in one place.
 * v5 makes the tag-narrowing part of the named contract too.
 *
 * Stub-body convention: impl-staff fills only the INNER logic per
 * method. The wrapper invocation is part of the stub surface and is
 * verified by the type-canary: the public method's return type is
 * `Effect<T, never, never>` and the wrapper is the only thing that
 * can satisfy that promise once `Effect.die` is in play inside the
 * body.
 *
 * Signature (impl-staff fills the body — the stub `throws "not
 * implemented"` per architect SKILL.md):
 *
 *     function catchProjectionDefect<A>(
 *       effect: Effect.Effect<A, never, never>,
 *       fallback: A,
 *     ): Effect.Effect<A, never, never>
 *
 * Recipe in the body (v5 — narrowed):
 *
 *     return effect.pipe(
 *       Effect.catchAllDefect((defect) =>
 *         defect instanceof PresenceProjectionDefect
 *           ? Effect.logError("presence projection defect", { defect }).pipe(
 *               Effect.as(fallback),
 *             )
 *           : Effect.die(defect),
 *       ),
 *     );
 *
 * The `instanceof PresenceProjectionDefect` narrowing IS the
 * load-bearing change. Using `Effect.catchTag` here is not idiomatic
 * because `Effect.die(value)` raises `value` as a defect, not as a
 * typed error in the E channel — `catchTag` operates on the E
 * channel. `Effect.catchAllDefect` + `instanceof` is the canonical
 * pattern for narrowing within the defect channel.
 *
 * Regression-test obligation (impl-staff §10): a projection method
 * body that throws a `TypeError` (NOT a `PresenceProjectionDefect`)
 * MUST propagate up as a defect, not resolve as `"offline"` / `void`.
 * The wrapper is correct iff the test sees the fresh defect.
 */
export function catchProjectionDefect<A>(
  effect: Effect.Effect<A, never, never>,
  fallback: A,
): Effect.Effect<A, never, never> {
  void effect;
  void fallback;
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- architect stub body per SKILL.md "every stub body is exactly `throw new Error("not implemented")`"
  throw new Error("not implemented");
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
 *    Every transition method takes the in-module-curried
 *    {@link EmitIfChanged} value as its emit capability — NEVER the
 *    raw `InternalPresenceEventSink` (architect plan v5 / codex
 *    r4 P2 #2). Dedup + snapshot are folded into `emit(prev, next, agentId)`
 *    so the transition methods never call `sink.publish` directly.
 *
 *    Pseudocode (lifecycle path — `onAgentConnect` / `onAgentDisconnect`;
 *    `prev === next` short-circuits inside `emit` via the dedup gate,
 *    NOT via `Effect.die`):
 *
 *    ```
 *    const transition = yield* Ref.modify(entriesRef, (entries) => {
 *      const entry = entries.get(agentId);
 *      // onAgentConnect: insert if absent, else no-op
 *      // onAgentDisconnect: drop if present, else no-op
 *      const [nextEntries, prevStatus, nextStatus] = computeLifecycle(entries, entry);
 *      return [{ prevStatus, nextStatus }, nextEntries];
 *    });
 *    yield* emit(transition.prevStatus, transition.nextStatus, agentId);
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
 *      return [
 *        { _tag: "transition", prevStatus: prev, nextStatus },
 *        setReadonlyMapValue(agentId, nextEntry)(entries),
 *      ];
 *    });
 *    yield* result._tag === "audit"
 *      ? Effect.logDebug("presence projection audit", result.event)
 *      : emit(result.prevStatus, result.nextStatus, agentId);
 *    ```
 *
 *    `emit` is the only path from in-module state to wire publish —
 *    see (6.1) below for the in-module seal rationale.
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
 *    module; the compiler is the structural gate against EXTERNAL
 *    bypass (see {@link InternalPresenceEventSink}).
 *
 * 6.1. **In-module emit seal via {@link EmitIfChanged}** (v5 / codex
 *    r4 P2 #2) — the sink is wrapped ONCE inside this factory's
 *    closure via `createEmitIfChanged({ sink, subscribers:
 *    deps.subscribers })`. The resulting {@link EmitIfChanged} value
 *    is the only emission capability the per-transition local helpers
 *    receive; the raw sink is never closed over by them. This makes
 *    the dedup gate (and snapshot consistency in (5)) enforced at
 *    the IN-MODULE call-site level too — a future in-module helper
 *    that wants to emit MUST take an `emit: EmitIfChanged` parameter
 *    and cannot reach the raw `sink.publish` through any other path
 *    in the module. Combined with (6) (the external seal), the
 *    dedup rule is structurally enforced across both axes.
 *
 * 7. **First-writer-wins discipline** — the `Ref.modify` predicate
 *    matches `LeaseRegistry`'s own atomicity model. No second `Ref.get`
 *    + `Ref.update` pair; the predicate IS the linearization point.
 *
 * 8. **Defect-boundary wrapper (v4 / codex r3 P3 #2)** — every public
 *    method on the returned `PresenceProjection` MUST be wrapped in
 *    {@link catchProjectionDefect} with a method-appropriate fallback
 *    (`void` for emit methods; `"offline"` / per-agent `"offline"` rows
 *    for read methods). The wrapper is the only way the public `never`
 *    E channels stay honest in the presence of
 *    `Effect.die(new PresenceProjectionDefect(...))`. Recipe:
 *
 *    ```ts
 *    const onAgentConnect = (agentId: AgentId) =>
 *      catchProjectionDefect(
 *        // ... Ref.modify + emission body ...
 *        undefined as void,
 *      );
 *
 *    const statusOf = (agentId: AgentId) =>
 *      catchProjectionDefect(
 *        // ... Ref.get + lookup body ...
 *        "offline" as DerivedPresenceStatus,
 *      );
 *
 *    const statusMany = (agentIds: ReadonlyArray<AgentId>) =>
 *      catchProjectionDefect(
 *        // ... Ref.get + iterate body ...
 *        agentIds.map((agentId) => ({ agentId, status: "offline" as const })),
 *      );
 *    ```
 */
export function makePresenceProjection(
  deps: PresenceProjectionDeps,
): Effect.Effect<PresenceProjection, never, never> {
  void deps;
  void createInternalFanOutEventSink;
  // v5 (codex r4 P2 #2): keep `createEmitIfChanged` reachable from
  // the factory closure so the in-module seal helper is exercised
  // by the canary. Impl-staff calls `createEmitIfChanged({ sink,
  // subscribers: deps.subscribers })` once and passes the returned
  // `EmitIfChanged` to every transition-method helper.
  void createEmitIfChanged;
  // v4 (codex r3 P3 #2): keep `catchProjectionDefect` reachable from
  // the factory closure so the canary type-checks the helper exists.
  // Impl-staff wires every returned method through it; see this
  // file's `catchProjectionDefect` JSDoc + the recipe block in the
  // `makePresenceProjection` JSDoc above.
  void catchProjectionDefect;
  // eslint-disable-next-line agent-code-guard/no-raw-throw-new-error -- architect stub body per SKILL.md "every stub body is exactly `throw new Error("not implemented")`"
  throw new Error("not implemented");
}
