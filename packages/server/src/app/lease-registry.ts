import { Data, Effect } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId, MessageId, TaskId } from "@moltzap/protocol/task";
import type { DispatchId, LeaseId } from "@moltzap/protocol";
import type { ConnectionManager } from "../ws/connection.js";

/**
 * Lease registry — server-local admission state for the dispatch
 * reshape (#529 / #512). Replaces the synchronous Deferred-on-the-wire
 * pattern of `apps/authorizeDispatch` with an off-wire state machine
 * the server walks deterministically as moderator verdicts, durable
 * inserts, TTLs, and connection closures arrive.
 *
 * Doctrine notes:
 *
 * - Every public method returns `Effect<T, E, R>` with a typed error
 *   channel (Principle 3). `Promise<T>` is forbidden on this surface.
 * - State transitions are atomic via `Ref.modify` (or equivalent
 *   first-writer-wins primitive at impl time). The state machine
 *   below names every transition; impl-staff exhaustively asserts via
 *   `absurd(s)` on the state union (Principle 4).
 * - Lease and dispatch ids are branded (`LeaseId` / `DispatchId` from
 *   `@moltzap/protocol`); raw strings cannot be confused at call
 *   sites (Principle 1).
 * - SQL-shaped failures (binding-tuple persistence, if any) surface
 *   as defects via `catchSqlErrorAsDefect` per repo convention; the
 *   public Effect channels expose only the registry-modeled errors
 *   below.
 *
 * ─── State machine ──────────────────────────────────────────────────
 *
 * ```
 *  mint                         resolve(grant)               claim
 * ─────▶ PENDING ──────────────────────▶ GRANTED ──────────────▶ CLAIMED
 *           │                              │                       │
 *           │ resolve(deny)                │ TTL                   │ finalize(messageId)
 *           ├────────────▶ DENIED          ├────────────▶ EXPIRED  ├─────────────▶ CONSUMED
 *           │ resolve(hold)                │                       │
 *           ├────────────▶ HOLD            │                       │ rollback
 *           │ connection-close             │                       └─────────────▶ GRANTED
 *           ├────────────▶ ABANDONED       │
 *           │ moderator timeout            │
 *           └─synthesize deny─▶ DENIED     │
 *                                          │ connection-close
 *                                          └────────────▶ EXPIRED-on-disconnect
 *                                                          (terminal)
 * ```
 *
 * Two load-bearing rules (parent plan §"Reshape PR (additive)"):
 *
 * 1. **TTL skip on CLAIMED.** The TTL transition GRANTED → EXPIRED is
 *    a `Ref.modify` predicate that is a no-op on CLAIMED state. Only
 *    `finalize` or `rollback` leaves CLAIMED. Without this rule, a
 *    TTL firing mid-`messageService.sendInsert` would expire the
 *    lease while the durable row commits — `dispatches/consumed`
 *    would never fire and the moderator's view would be inconsistent
 *    with the database.
 *
 * 2. **Connection close no-op on CLAIMED.** Recipient disconnect mid-
 *    insert MUST NOT roll back the lease. The in-flight
 *    `messages/send` owns the lease via `Effect.acquireUseRelease`
 *    in the messages handler; the close finalizer waits for the
 *    wrapped insert+finalize/rollback to complete before draining
 *    its own state. Without this rule, a disconnect mid-insert
 *    rolls back a committed durable row and a duplicate retry can
 *    create a duplicate message.
 *
 * Terminal states (CONSUMED / DENIED / EXPIRED / ABANDONED) age out
 * of the registry on the same `leaseRetentionMs` clock; HOLD inherits
 * the post-grant TTL.
 */

/**
 * Audit binding tuple recorded at `mint` time. Used by `dispatches/get`
 * scope-enforcement and connection-close cleanup. Once recorded, the
 * tuple is immutable for the lease's lifetime.
 */
export interface LeaseBindingTuple {
  readonly recipientAgentId: AgentId;
  readonly recipientConnectionId: string;
  readonly moderatorConnectionId: string;
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly tmEndpointAddress: string;
  readonly appId: string;
}

/**
 * Discriminated state of a lease. The registry's `Ref.modify`
 * transitions read this discriminator and reject illegal transitions
 * with a typed error (see {@link LeaseInvalidError}).
 */
export type LeaseState =
  | "PENDING"
  | "CLAIMED"
  | "GRANTED"
  | "CONSUMED"
  | "DENIED"
  | "EXPIRED"
  | "ABANDONED"
  | "HOLD";

/** Verdict shapes accepted by `resolve` — mirrors the wire decision. */
export type LeaseVerdict =
  | { readonly _tag: "grant"; readonly leaseTimeoutMs?: number }
  | { readonly _tag: "deny"; readonly reason?: string }
  | { readonly _tag: "hold"; readonly reason?: string };

/**
 * Snapshot of a lease for `dispatches/get` and observability tests.
 * Mirrors the wire `LeaseRecordSchema` shape; ISO-8601 timestamps for
 * cross-boundary stability.
 */
export interface LeaseRecord {
  readonly dispatchId: DispatchId;
  readonly leaseId: LeaseId;
  readonly binding: LeaseBindingTuple;
  readonly state: LeaseState;
  readonly verdict: LeaseVerdict | null;
  readonly mintedAt: string;
  readonly resolvedAt: string | null;
  readonly consumedAt: string | null;
  readonly consumedMessageId: MessageId | null;
  readonly expiredAt: string | null;
  readonly leaseTimeoutMs: number | null;
}

/**
 * Inputs to `mint`. Captured into the binding tuple plus mint
 * timestamp; the registry generates `leaseId` and `dispatchId`
 * internally via `crypto.randomUUID()` (≥122 bits entropy per spec).
 */
export interface LeaseMintContext {
  readonly recipientAgentId: AgentId;
  readonly recipientConnectionId: string;
  readonly moderatorConnectionId: string;
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly tmEndpointAddress: string;
  readonly appId: string;
}

/**
 * Lease mint result. Both ids are branded — calling code cannot
 * accidentally confuse them with `MessageId` / `TaskId` / generic
 * strings.
 */
export interface LeaseMintResult {
  readonly leaseId: LeaseId;
  readonly dispatchId: DispatchId;
}

/**
 * Tagged error channel for the registry's transition-rejecting paths.
 * The `state` carries the lease's CURRENT state (so callers can
 * surface a precise wire-error code per #529's typed-CONSUMED /
 * typed-EXPIRED requirements) and `expected` carries the set of
 * states the operation would have accepted.
 */
export class LeaseInvalidError extends Data.TaggedError("LeaseInvalidError")<{
  readonly leaseId: LeaseId;
  readonly state: LeaseState;
  readonly expected: ReadonlyArray<LeaseState>;
  readonly operation:
    | "resolve"
    | "claim"
    | "finalize"
    | "rollback"
    | "read"
    | "bindToConnection";
}> {
  override get message(): string {
    return `lease ${this.leaseId} in state ${this.state} cannot ${this.operation} (expected one of ${this.expected.join(", ")})`;
  }
}

/**
 * Lookup-by-id failure when the registry has no entry for the supplied
 * id. Distinct from `LeaseInvalidError` — that error fires when the
 * lease exists but is in the wrong state. `LeaseNotFoundError` fires
 * when the id is unknown (caller forged it, or it aged out of the
 * retention window).
 */
export class LeaseNotFoundError extends Data.TaggedError("LeaseNotFoundError")<{
  readonly id: LeaseId | DispatchId;
  readonly kind: "leaseId" | "dispatchId";
}> {
  override get message(): string {
    return `no lease record for ${this.kind}=${this.id}`;
  }
}

/**
 * Active claim handle returned by `claim`. Implements
 * acquire-use-release: the wrapping `Effect.acquireUseRelease` MUST
 * call exactly one of `finalize` or `rollback` on the release path.
 * The handle carries the lease id privately so callers cannot forge a
 * finalize against a different lease.
 */
export interface Claim {
  readonly leaseId: LeaseId;
  /** CLAIMED → CONSUMED. Idempotent with respect to a successful
   *  durable insert — calling twice on the same handle is a typed
   *  defect (impl-staff's responsibility to assert). */
  readonly finalize: (
    messageId: MessageId,
  ) => Effect.Effect<void, LeaseInvalidError, never>;
  /** CLAIMED → GRANTED. Used by the `Effect.acquireUseRelease`
   *  release path when `sendInsert` fails after `claim` succeeded but
   *  before `finalize`. */
  readonly rollback: Effect.Effect<void, LeaseInvalidError, never>;
}

/**
 * Public contract of the lease registry. Constructed once per server
 * lifetime; held by `AppHost` and the messages handler.
 *
 * Implementation hint for impl-staff (#529 §3 stub-comment marker):
 * the timer wheel / min-heap for TTLs runs on a single fiber;
 * per-lease scheduler fibers are forbidden (Final Decision #9).
 * Manifest-driven TTLs come from `manifest.hooks.dispatch_authorize.
 * timeout_ms` (moderator response) and the verdict's `leaseTimeoutMs`
 * (post-grant lease).
 */
export interface LeaseRegistry {
  /**
   * Mint a new PENDING lease. Synchronous (`Effect<..., never>`) — the
   * registry is in-process. Records the binding tuple for audit,
   * `dispatches/get`, and connection-close cleanup.
   *
   * Both ids are minted via `crypto.randomUUID()`; the brand on
   * `LeaseId` / `DispatchId` keeps them disjoint at every call site.
   */
  mint(ctx: LeaseMintContext): Effect.Effect<LeaseMintResult, never, never>;

  /**
   * Settle a PENDING lease into a terminal-or-near-terminal state via
   * the moderator's verdict (or a synthesized verdict for default-
   * grant / moderator-unavailable / moderator-timeout). First writer
   * wins via `Ref.modify`; second `resolve` against the same lease
   * fails with `LeaseInvalidError`. Internally calls
   * {@link emitRelease} so `dispatch/release` fires on every
   * resolution path uniformly.
   */
  resolve(
    leaseId: LeaseId,
    verdict: LeaseVerdict,
  ): Effect.Effect<void, LeaseInvalidError | LeaseNotFoundError, never>;

  /**
   * Atomic GRANTED → CLAIMED. Called from the messages handler
   * BEFORE `messageService.sendInsert`. CLAIMED is the in-flight
   * state — the lease is reserved by this caller but the durable
   * insert has not yet committed.
   *
   * Two transitions out of CLAIMED only: `finalize` (success) or
   * `rollback` (insert failure). The TTL transition skips CLAIMED
   * (load-bearing rule 1); the connection-close transition skips
   * CLAIMED (load-bearing rule 2).
   */
  claim(
    leaseId: LeaseId,
  ): Effect.Effect<Claim, LeaseInvalidError | LeaseNotFoundError, never>;

  /**
   * Snapshot read for `dispatches/get`. Includes live `leaseId` —
   * the moderator IS the authority for the lease (#11), live-id
   * visibility is in-scope.
   *
   * Lookup by either id flavor; the `kind` discriminator on the
   * error tells the caller which key was used. Scope enforcement
   * (caller must be the lease's bound moderator) is the handler's
   * responsibility, not the registry's.
   */
  read(
    id:
      | { readonly _tag: "leaseId"; readonly value: LeaseId }
      | {
          readonly _tag: "dispatchId";
          readonly value: DispatchId;
        },
  ): Effect.Effect<LeaseRecord, LeaseNotFoundError, never>;

  /**
   * Update the lease's recipient-connection binding. Called when the
   * recipient reconnects (rare — on disconnect the lease normally
   * transitions to ABANDONED or EXPIRED-on-disconnect via the
   * close finalizer). Idempotent for the same `connId`; rejects the
   * binding update if the lease is already terminal.
   */
  bindToConnection(
    leaseId: LeaseId,
    connId: string,
  ): Effect.Effect<void, LeaseInvalidError | LeaseNotFoundError, never>;

  /**
   * Internal-but-exported emission helper. Single point of truth for
   * `dispatch/release` notifications: `resolve` calls this; nothing
   * else does. The `mint` path for default-grant calls `resolve`
   * inline with a synthesized grant verdict, so `emitRelease` is
   * still the single emission site (Final Decision #3 — always emit
   * release).
   *
   * Lookup of the recipient connection runs through the registry's
   * injected `ConnectionManager`; if the connection is gone, the
   * notification is logged and dropped (the recipient's reconnect
   * path replays from server state).
   */
  emitRelease(
    leaseId: LeaseId,
    verdict: LeaseVerdict,
  ): Effect.Effect<void, never, never>;
}

/**
 * Constructor dependencies for the lease registry.
 * - `connections`: looked up at `emitRelease` time to find the
 *   recipient and at `dispatches/consumed` / `dispatches/expired`
 *   emission to find the moderator's connection.
 * - `leaseRetentionMs`: terminal-state retention window (CONSUMED /
 *   DENIED / EXPIRED / ABANDONED). Live states (PENDING / GRANTED /
 *   HOLD / CLAIMED) age out on their own TTLs.
 */
export interface LeaseRegistryDeps {
  readonly connections: ConnectionManager;
  readonly leaseRetentionMs: number;
}

/**
 * Construct the registry. The constructor is the only public factory
 * — `LeaseRegistry` is referenced as an interface from call sites.
 * Implementation is stubbed for #529; impl-staff fills in the body.
 *
 * SAFER-IMPL-STAFF: replace this stub with the live
 * `Ref<Map<LeaseId, LeaseEntry>>` + timer-wheel implementation.
 * Keep the public surface (interface above) stable; `Ref.modify`
 * predicates are internal.
 */
export function makeLeaseRegistry(
  deps: LeaseRegistryDeps,
): Effect.Effect<LeaseRegistry, never, never> {
  // SAFER-IMPL-STAFF: not implemented in stub. The interface above is
  // the contract — every method's typed Effect channel is the
  // implementation's full obligation. The `deps` parameter is named
  // for downstream impl reference; the stub annotates it under the
  // dieMessage so the unused-vars rule treats it as load-bearing.
  return Effect.dieMessage(
    `LeaseRegistry: not implemented (architect stub for #529; deps: connections=<ConnectionManager> leaseRetentionMs=${String(deps.leaseRetentionMs)})`,
  );
}
