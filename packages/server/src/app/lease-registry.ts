/* eslint-disable jsdoc/text-escaping -- mermaid sequenceDiagram blocks need literal `<br>` (HTML5) for renderer compatibility; the escape would render as literal text. */
import { Data, Effect, Fiber, Ref } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConnectionId } from "@moltzap/protocol/network";
import type {
  AppId,
  ConversationId,
  MessageId,
  TaskId,
} from "@moltzap/protocol/task";
import type {
  DispatchId,
  DispatchesGet,
  LeaseId,
  ResultOf,
} from "@moltzap/protocol";
import {
  DispatchRelease,
  DispatchesConsumed,
  DispatchesExpired,
} from "@moltzap/protocol";
import type { ConnectionManager } from "../transport/connection.js";

/** Wire-side LeaseRecord shape (flat). */
type LeaseRecordWire = ResultOf<typeof DispatchesGet>["lease"];

/**
 * Lease registry — server-local admission state for the dispatch
 * reshape (#529 / #512). Replaces the synchronous Deferred-on-the-wire
 * pattern of `apps/authorizeDispatch` with an off-wire state machine
 * the server walks deterministically as moderator verdicts, durable
 * inserts, TTLs, and connection closures arrive.
 *
 * Doctrine notes:
 *
 * - Every public method returns `Effect&lt;T, E, R>` with a typed error
 *   channel (Principle 3). `Promise&lt;T>` is forbidden on this surface.
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
 *           │ resolve(hold)                │   ▲                   │
 *           ├────────────▶ HOLD ── TTL ────┘   │                   │ rollback
 *           │ connection-close                 │                   └─────────────▶ GRANTED
 *           ├────────────▶ ABANDONED           │
 *           │ moderator timeout                │
 *           └─synthesize deny─▶ DENIED         │
 *                                              │ connection-close
 *                                              └────────────▶ EXPIRED-on-disconnect
 *                                                              (terminal)
 * ```
 *
 * Note: HOLD inherits the same post-grant TTL as GRANTED — both age out
 * to EXPIRED. CLAIMED and terminal states (CONSUMED / DENIED / EXPIRED /
 * ABANDONED) skip TTL.
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
  readonly recipientConnectionId: ConnectionId;
  readonly moderatorConnectionId: ConnectionId;
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly appId: AppId;
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
  readonly recipientConnectionId: ConnectionId;
  readonly moderatorConnectionId: ConnectionId;
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly appId: AppId;
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

  /**
   * CLAIMED → CONSUMED. Idempotent with respect to a successful durable
   * insert — calling twice on the same handle is a typed defect.
   */
  readonly finalize: (
    messageId: MessageId,
  ) => Effect.Effect<void, LeaseInvalidError, never>;

  /**
   * CLAIMED → GRANTED. Used by the `Effect.acquireUseRelease` release path
   * when `sendInsert` fails after `claim` succeeded but before `finalize`.
   */
  readonly rollback: Effect.Effect<void, LeaseInvalidError, never>;
}

/**
 * Public contract of the lease registry. One instance per server
 * lifetime; held by `AppHost` and the messages handler. Backed by an
 * in-process `Ref&lt;Map&lt;LeaseId, LeaseEntry>>` with per-lease TTL
 * fibers — no DB row. State transitions are atomic via `Ref.modify`.
 *
 * Lease state machine (eight states; `LeaseState` in this file is the
 * normative enumeration):
 *
 * ```mermaid
 * stateDiagram-v2
 *   [*] --> PENDING
 *   PENDING --> GRANTED : verdict grant
 *   PENDING --> DENIED : verdict deny
 *   PENDING --> HOLD : verdict hold
 *   PENDING --> ABANDONED : conn close
 *   HOLD --> PENDING : retry on next inbound message in same conv
 *   GRANTED --> CLAIMED : messages/send claim
 *   GRANTED --> EXPIRED : TTL fires OR conn close
 *   HOLD --> EXPIRED : conn close
 *   CLAIMED --> CONSUMED : insert ok — finalize(messageId)
 *   CLAIMED --> GRANTED : insert fail — rollback
 *   CONSUMED --> [*]
 *   DENIED --> [*]
 *   ABANDONED --> [*]
 *   EXPIRED --> [*]
 * ```
 *
 * Mint + claim + finalize sequence (recipient + moderator round-trip):
 *
 * ```mermaid
 * sequenceDiagram
 *   participant Recv as Recipient (client)
 *   participant AH as apps.handlers
 *   participant LR as LeaseRegistry
 *   participant Mod as Moderator
 *   participant MS as MessageService
 *
 *   Recv->>AH: dispatch/request (C→S)
 *   AH->>LR: mint(ctx) — PENDING
 *   LR-->>AH: {leaseId, dispatchId}
 *   AH-->>Recv: ack returned immediately
 *   AH->>Mod: Effect.fork — dispatchAuthorizeHook
 *   Mod-->>AH: verdict
 *   AH->>LR: resolve(leaseId, verdict) — GRANTED | DENIED | HOLD
 *   AH->>Recv: dispatch/release {verdict}
 *   Recv->>MS: messages/send with dispatchLeaseId
 *   MS->>LR: claim(leaseId) — GRANTED → CLAIMED
 *   Note over MS: Effect.acquireUseRelease<br>use sendInsert returns carrier<br>release Exit success → claim.finalize CLAIMED → CONSUMED<br>release Exit failure → claim.rollback CLAIMED → GRANTED
 *   MS->>MS: sendCommit — post-insert side effects
 * ```
 *
 * Post-insert side effects (`sendCommit`) DO NOT affect lease state:
 * a failure there leaves the lease CONSUMED and the durable row
 * intact. Callers must not retry.
 *
 * Connection-close cleanup runs `abandon(connId)` from the disconnect
 * finalizer: PENDING → ABANDONED, GRANTED/HOLD → EXPIRED, CLAIMED →
 * no-op. The CLAIMED no-op is load-bearing — without it, a recipient
 * disconnect mid-insert could roll back a committed durable row,
 * permitting a duplicate retry.
 *
 * Timer wheel / min-heap for TTLs runs on a single fiber; per-lease
 * scheduler fibers are forbidden. Manifest TTLs come from
 * `manifest.hooks.dispatch_authorize.timeout_ms` (moderator response)
 * and the verdict's `leaseTimeoutMs` (post-grant lease).
 */
export interface LeaseRegistry {
  /**
   * Mint a new PENDING lease. Synchronous (`Effect&lt;..., never>`) — the
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
    connId: ConnectionId,
  ): Effect.Effect<void, LeaseInvalidError | LeaseNotFoundError, never>;

  /**
   * Connection-close cleanup. Called from the WS disconnect-hook chain
   * with the closing connection id. Iterates leases bound to that
   * recipientConnectionId and applies the architect §3 transitions:
   *
   * - **PENDING → ABANDONED**: cancels the forked moderator round-trip
   *   (its `resolve` call against the now-ABANDONED lease will return
   *   `LeaseInvalidError(state=ABANDONED, expected=PENDING)`, which the
   *   forked fiber catches and discards). No `dispatch/release`
   *   notification fires (the recipient is gone). Architect §3 + §8 #15.
   *
   * - **GRANTED → EXPIRED-on-disconnect**: terminal state; emits
   *   `dispatches/expired` to the moderator. Cancels the post-grant TTL
   *   fiber. The recipient won't observe; the moderator's view stays
   *   consistent. Architect §3.
   *
   * - **CLAIMED → no-op (load-bearing rule 2)**: a CLAIMED lease has an
   *   in-flight `messages/send` owning it via `Effect.acquireUseRelease`.
   *   Disconnecting mid-insert MUST NOT roll back the lease — the
   *   release-arm of the acquireUseRelease is responsible. Otherwise a
   *   committed durable row could be retried into a duplicate.
   *
   * - **HOLD / DENIED / EXPIRED / ABANDONED / CONSUMED**: no-op (already
   *   terminal-or-near-terminal; no recipient-binding work to do).
   *
   * Errors are absorbed: connection-close cleanup is fire-and-forget;
   * any per-lease transition failure is logged-and-dropped (the
   * disconnect path must complete even if a single lease's state is
   * unexpected). Public error channel is `never`.
   */
  abandon(connId: ConnectionId): Effect.Effect<void, never, never>;

  /**
   * Internal — record the forked moderator round-trip fiber so
   * {@link abandon} can interrupt it on recipient disconnect. The
   * caller forks the round-trip immediately after `mint`; the registry
   * interrupts the fiber when the binding's recipient connection
   * closes (PENDING → ABANDONED transition). No-op if the lease is no
   * longer in PENDING when the fiber is attached. Idempotent.
   */
  attachRoundTripFiber(
    leaseId: LeaseId,
    fiber: Fiber.RuntimeFiber<unknown, unknown>,
  ): Effect.Effect<void, never, never>;

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
 * Internal entry — wraps the public `LeaseRecord` plus the recipient-
 * connection binding needed for `dispatch/release` fan-out and the
 * scheduled fiber for the post-grant TTL.
 */
interface LeaseEntry {
  readonly record: LeaseRecord;
  readonly ttlFiber: Fiber.RuntimeFiber<unknown, unknown> | null;

  /**
   * Forked moderator round-trip fiber. Attached by
   * {@link LeaseRegistry.attachRoundTripFiber} immediately after the
   * caller forks. Interrupted on PENDING → ABANDONED so the in-flight
   * dispatch/authorize hook is cancelled rather than leaking until
   * timeout. Null after the fiber completes naturally (resolve fired)
   * or the lease left PENDING.
   */
  readonly roundTripFiber: Fiber.RuntimeFiber<unknown, unknown> | null;
}

function setReadonlyMapValue<K, V>(
  key: K,
  value: V,
): (map: ReadonlyMap<K, V>) => ReadonlyMap<K, V> {
  return (map) => {
    const next = new Map(map);
    next.set(key, value);
    return next;
  };
}

function leaseStateForVerdict(verdict: LeaseVerdict): LeaseState {
  switch (verdict._tag) {
    case "grant":
      return "GRANTED";
    case "deny":
      return "DENIED";
    case "hold":
      return "HOLD";
  }
}

function leaseTimeoutForVerdict(verdict: LeaseVerdict): number | null {
  if (verdict._tag !== "grant") return null;
  return verdict.leaseTimeoutMs ?? null;
}

/**
 * Translation point between the in-process nested `LeaseRecord`
 * (binding field carries the full audit tuple) and the wire
 * `LeaseRecordSchema` shape (flat fields). Centralizing this keeps the
 * in-process representation as the single source of truth for the
 * authoritative tuple while the wire schema stays flat for simple
 * ergonomics on the moderator client side.
 *
 * Advisory carry-over from review-senior-arch529 #2.
 */
export function leaseRecordToWire(record: LeaseRecord): LeaseRecordWire {
  return {
    dispatchId: record.dispatchId,
    leaseId: record.leaseId,
    conversationId: record.binding.conversationId,
    taskId: record.binding.taskId,
    appId: record.binding.appId,
    recipientAgentId: record.binding.recipientAgentId,
    moderatorConnectionId: record.binding.moderatorConnectionId,
    state: record.state,
    verdict: leaseVerdictToWire(record.verdict),
    mintedAt: record.mintedAt,
    resolvedAt: record.resolvedAt,
    consumedAt: record.consumedAt,
    consumedMessageId: record.consumedMessageId,
    expiredAt: record.expiredAt,
    leaseTimeoutMs: record.leaseTimeoutMs,
  };
}

/** Map the in-process verdict to the wire admission decision shape. */
function leaseVerdictToWire(
  v: LeaseVerdict | null,
):
  | { decision: "grant"; leaseTimeoutMs?: number }
  | { decision: "deny"; reason?: string }
  | { decision: "hold"; reason?: string }
  | null {
  if (v === null) return null;
  switch (v._tag) {
    case "grant":
      return v.leaseTimeoutMs !== undefined
        ? { decision: "grant", leaseTimeoutMs: v.leaseTimeoutMs }
        : { decision: "grant" };
    case "deny":
      return v.reason !== undefined
        ? { decision: "deny", reason: v.reason }
        : { decision: "deny" };
    case "hold":
      return v.reason !== undefined
        ? { decision: "hold", reason: v.reason }
        : { decision: "hold" };
    default: {
      const _absurd: never = v;
      return _absurd;
    }
  }
}

interface LeaseRegistryState {
  readonly deps: LeaseRegistryDeps;
  readonly entriesRef: Ref.Ref<ReadonlyMap<LeaseId, LeaseEntry>>;
  readonly dispatchIndexRef: Ref.Ref<ReadonlyMap<DispatchId, LeaseId>>;
}

interface LeaseConnectionTarget {
  readonly leaseId: LeaseId;
  readonly entry: LeaseEntry;
}

const BINDABLE_LEASE_STATES: ReadonlyArray<LeaseState> = [
  "PENDING",
  "GRANTED",
  "HOLD",
  "CLAIMED",
];

const TERMINAL_BIND_STATES: ReadonlyArray<LeaseState> = [
  "CONSUMED",
  "DENIED",
  "EXPIRED",
  "ABANDONED",
];

function leaseNotFound(
  id: LeaseId | DispatchId,
  kind: "leaseId" | "dispatchId",
): LeaseNotFoundError {
  return new LeaseNotFoundError({ id, kind });
}

function invalidLeaseState(
  leaseId: LeaseId,
  state: LeaseState,
  expected: ReadonlyArray<LeaseState>,
  operation: LeaseInvalidError["operation"],
): LeaseInvalidError {
  return new LeaseInvalidError({ leaseId, state, expected, operation });
}

function writeFrame(
  state: LeaseRegistryState,
  connId: ConnectionId,
  raw: string,
): Effect.Effect<void, never, never> {
  const conn = state.deps.connections.get(connId);
  if (!conn) {
    return Effect.logDebug(
      "lease-registry: target connection gone; dropping notification",
    ).pipe(Effect.annotateLogs({ connId }));
  }
  return conn
    .write(raw)
    .pipe(
      Effect.catchAll((cause) =>
        Effect.logWarning("lease-registry: socket write failed").pipe(
          Effect.annotateLogs({ connId, cause: String(cause) }),
        ),
      ),
    );
}

function emitDispatchRelease(
  state: LeaseRegistryState,
  record: LeaseRecord,
  verdict: LeaseVerdict,
): Effect.Effect<void, never, never> {
  const wire = leaseVerdictToWire(verdict);
  if (wire === null) return Effect.void;
  const frame = DispatchRelease.encode({
    dispatchId: record.dispatchId,
    leaseId: record.leaseId,
    verdict: wire,
    ...(verdict._tag === "grant" && verdict.leaseTimeoutMs !== undefined
      ? { leaseTimeoutMs: verdict.leaseTimeoutMs }
      : {}),
  });
  return writeFrame(
    state,
    record.binding.recipientConnectionId,
    JSON.stringify(frame),
  );
}

function emitDispatchesConsumed(
  state: LeaseRegistryState,
  record: LeaseRecord,
  messageId: MessageId,
  consumedAt: string,
): Effect.Effect<void, never, never> {
  const frame = DispatchesConsumed.encode({
    dispatchId: record.dispatchId,
    leaseId: record.leaseId,
    conversationId: record.binding.conversationId,
    messageId,
    consumedAt,
  });
  return writeFrame(
    state,
    record.binding.moderatorConnectionId,
    JSON.stringify(frame),
  );
}

function emitDispatchesExpired(
  state: LeaseRegistryState,
  record: LeaseRecord,
  expiredAt: string,
): Effect.Effect<void, never, never> {
  const frame = DispatchesExpired.encode({
    dispatchId: record.dispatchId,
    leaseId: record.leaseId,
    conversationId: record.binding.conversationId,
    expiredAt,
  });
  return writeFrame(
    state,
    record.binding.moderatorConnectionId,
    JSON.stringify(frame),
  );
}

function replaceEntry(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  next: LeaseEntry,
): Effect.Effect<void, never, never> {
  return Ref.update(state.entriesRef, (m) => {
    const out = new Map(m);
    out.set(leaseId, next);
    return out;
  });
}

function removeEntry(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  dispatchId: DispatchId,
): Effect.Effect<void, never, never> {
  return Effect.zip(
    Ref.update(state.entriesRef, (m) => {
      const out = new Map(m);
      out.delete(leaseId);
      return out;
    }),
    Ref.update(state.dispatchIndexRef, (m) => {
      const out = new Map(m);
      out.delete(dispatchId);
      return out;
    }),
  ).pipe(Effect.asVoid);
}

function scheduleRetention(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  dispatchId: DispatchId,
): Effect.Effect<void, never, never> {
  return Effect.forkDaemon(
    Effect.sleep(`${state.deps.leaseRetentionMs} millis`).pipe(
      Effect.flatMap(() => removeEntry(state, leaseId, dispatchId)),
    ),
  ).pipe(Effect.asVoid);
}

function isTtlExpirableState(state: LeaseState): boolean {
  return state === "GRANTED" || state === "HOLD";
}

function expireLeaseFromTtl(
  state: LeaseRegistryState,
  leaseId: LeaseId,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const current = yield* Ref.get(state.entriesRef);
    const entry = current.get(leaseId);
    if (!entry || !isTtlExpirableState(entry.record.state)) return;
    const expiredAt = new Date().toISOString();
    const nextRecord: LeaseRecord = {
      ...entry.record,
      state: "EXPIRED",
      expiredAt,
    };
    yield* replaceEntry(state, leaseId, {
      record: nextRecord,
      ttlFiber: null,
      roundTripFiber: null,
    });
    yield* emitDispatchesExpired(state, nextRecord, expiredAt);
    yield* scheduleRetention(state, leaseId, nextRecord.dispatchId);
  });
}

function scheduleTtl(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  timeoutMs: number,
): Effect.Effect<Fiber.RuntimeFiber<unknown, unknown>, never, never> {
  return Effect.forkDaemon(
    Effect.sleep(`${timeoutMs} millis`).pipe(
      Effect.flatMap(() => expireLeaseFromTtl(state, leaseId)),
    ),
  );
}

function getExistingLeaseEntry(
  state: LeaseRegistryState,
  leaseId: LeaseId,
): Effect.Effect<LeaseEntry, LeaseNotFoundError, never> {
  return Ref.get(state.entriesRef).pipe(
    Effect.flatMap((entries) =>
      entries.get(leaseId)
        ? Effect.succeed(entries.get(leaseId) as LeaseEntry)
        : Effect.fail(leaseNotFound(leaseId, "leaseId")),
    ),
  );
}

function assertLeaseState(
  leaseId: LeaseId,
  state: LeaseState,
  expected: ReadonlyArray<LeaseState>,
  operation: LeaseInvalidError["operation"],
): Effect.Effect<void, LeaseInvalidError, never> {
  return expected.includes(state)
    ? Effect.void
    : Effect.fail(invalidLeaseState(leaseId, state, expected, operation));
}

function getClaimedEntry(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  operation: "finalize" | "rollback",
): Effect.Effect<LeaseEntry, LeaseInvalidError, never> {
  return Effect.gen(function* () {
    const current = yield* Ref.get(state.entriesRef);
    const entry = current.get(leaseId);
    if (!entry) {
      return yield* Effect.fail(
        invalidLeaseState(leaseId, "EXPIRED", ["CLAIMED"], operation),
      );
    }
    yield* assertLeaseState(
      leaseId,
      entry.record.state,
      ["CLAIMED"],
      operation,
    );
    return entry;
  });
}

function finalizeClaim(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  messageId: MessageId,
): Effect.Effect<void, LeaseInvalidError, never> {
  return Effect.gen(function* () {
    const entry = yield* getClaimedEntry(state, leaseId, "finalize");
    const consumedAt = new Date().toISOString();
    const consumedRecord: LeaseRecord = {
      ...entry.record,
      state: "CONSUMED",
      consumedAt,
      consumedMessageId: messageId,
    };
    yield* replaceEntry(state, leaseId, {
      record: consumedRecord,
      ttlFiber: null,
      roundTripFiber: null,
    });
    yield* emitDispatchesConsumed(state, consumedRecord, messageId, consumedAt);
    yield* scheduleRetention(state, leaseId, consumedRecord.dispatchId);
  });
}

function rescheduleRollbackTtl(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  entry: LeaseEntry,
): Effect.Effect<Fiber.RuntimeFiber<unknown, unknown> | null, never, never> {
  if (entry.record.leaseTimeoutMs === null) {
    return Effect.succeed(null);
  }
  return scheduleTtl(state, leaseId, entry.record.leaseTimeoutMs);
}

function rollbackClaim(
  state: LeaseRegistryState,
  leaseId: LeaseId,
): Effect.Effect<void, LeaseInvalidError, never> {
  return Effect.gen(function* () {
    const entry = yield* getClaimedEntry(state, leaseId, "rollback");
    const ttlFiber = yield* rescheduleRollbackTtl(state, leaseId, entry);
    yield* replaceEntry(state, leaseId, {
      record: { ...entry.record, state: "GRANTED" },
      ttlFiber,
      roundTripFiber: null,
    });
  });
}

function makeClaim(state: LeaseRegistryState, leaseId: LeaseId): Claim {
  return {
    leaseId,
    finalize: (messageId) => finalizeClaim(state, leaseId, messageId),
    rollback: rollbackClaim(state, leaseId),
  };
}

function makeMintedLeaseRecord(
  ctx: LeaseMintContext,
  leaseId: LeaseId,
  dispatchId: DispatchId,
  mintedAt: string,
): LeaseRecord {
  return {
    dispatchId,
    leaseId,
    binding: {
      recipientAgentId: ctx.recipientAgentId,
      recipientConnectionId: ctx.recipientConnectionId,
      moderatorConnectionId: ctx.moderatorConnectionId,
      taskId: ctx.taskId,
      conversationId: ctx.conversationId,
      appId: ctx.appId,
    },
    state: "PENDING",
    verdict: null,
    mintedAt,
    resolvedAt: null,
    consumedAt: null,
    consumedMessageId: null,
    expiredAt: null,
    leaseTimeoutMs: null,
  };
}

function mintLease(
  state: LeaseRegistryState,
  ctx: LeaseMintContext,
): Effect.Effect<LeaseMintResult, never, never> {
  return Effect.gen(function* () {
    const leaseId = crypto.randomUUID() as LeaseId;
    const dispatchId = crypto.randomUUID() as DispatchId;
    const record = makeMintedLeaseRecord(
      ctx,
      leaseId,
      dispatchId,
      new Date().toISOString(),
    );
    const entry: LeaseEntry = { record, ttlFiber: null, roundTripFiber: null };
    yield* Ref.update(state.entriesRef, setReadonlyMapValue(leaseId, entry));
    yield* Ref.update(
      state.dispatchIndexRef,
      setReadonlyMapValue(dispatchId, leaseId),
    );
    return { leaseId, dispatchId };
  });
}

function scheduleResolvedTtl(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  leaseState: LeaseState,
  timeoutMs: number | null,
): Effect.Effect<Fiber.RuntimeFiber<unknown, unknown> | null, never, never> {
  if (timeoutMs === null || !isTtlExpirableState(leaseState)) {
    return Effect.succeed(null);
  }
  return scheduleTtl(state, leaseId, timeoutMs);
}

function resolveLease(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  verdict: LeaseVerdict,
): Effect.Effect<void, LeaseInvalidError | LeaseNotFoundError, never> {
  return Effect.gen(function* () {
    const entry = yield* getExistingLeaseEntry(state, leaseId);
    yield* assertLeaseState(
      leaseId,
      entry.record.state,
      ["PENDING"],
      "resolve",
    );
    const nextState = leaseStateForVerdict(verdict);
    const leaseTimeoutMs = leaseTimeoutForVerdict(verdict);
    const nextRecord: LeaseRecord = {
      ...entry.record,
      state: nextState,
      verdict,
      resolvedAt: new Date().toISOString(),
      leaseTimeoutMs,
    };
    const ttlFiber = yield* scheduleResolvedTtl(
      state,
      leaseId,
      nextState,
      leaseTimeoutMs,
    );
    yield* replaceEntry(state, leaseId, {
      record: nextRecord,
      ttlFiber,
      roundTripFiber: null,
    });
    yield* emitDispatchRelease(state, nextRecord, verdict);
    if (nextState === "DENIED") {
      yield* scheduleRetention(state, leaseId, nextRecord.dispatchId);
    }
  });
}

function claimLease(
  state: LeaseRegistryState,
  leaseId: LeaseId,
): Effect.Effect<Claim, LeaseInvalidError | LeaseNotFoundError, never> {
  return Effect.gen(function* () {
    const entry = yield* getExistingLeaseEntry(state, leaseId);
    yield* assertLeaseState(leaseId, entry.record.state, ["GRANTED"], "claim");
    if (entry.ttlFiber) {
      yield* Fiber.interrupt(entry.ttlFiber);
    }
    yield* replaceEntry(state, leaseId, {
      record: { ...entry.record, state: "CLAIMED" },
      ttlFiber: null,
      roundTripFiber: null,
    });
    return makeClaim(state, leaseId);
  });
}

function readLeaseByLeaseId(
  state: LeaseRegistryState,
  leaseId: LeaseId,
): Effect.Effect<LeaseRecord, LeaseNotFoundError, never> {
  return getExistingLeaseEntry(state, leaseId).pipe(
    Effect.map((entry) => entry.record),
  );
}

function readLeaseByDispatchId(
  state: LeaseRegistryState,
  dispatchId: DispatchId,
): Effect.Effect<LeaseRecord, LeaseNotFoundError, never> {
  return Effect.gen(function* () {
    const dispatches = yield* Ref.get(state.dispatchIndexRef);
    const leaseId = dispatches.get(dispatchId);
    if (!leaseId) {
      return yield* Effect.fail(leaseNotFound(dispatchId, "dispatchId"));
    }
    const entries = yield* Ref.get(state.entriesRef);
    const entry = entries.get(leaseId);
    if (!entry) {
      return yield* Effect.fail(leaseNotFound(dispatchId, "dispatchId"));
    }
    return entry.record;
  });
}

function readLease(
  state: LeaseRegistryState,
  id:
    | { readonly _tag: "leaseId"; readonly value: LeaseId }
    | { readonly _tag: "dispatchId"; readonly value: DispatchId },
): Effect.Effect<LeaseRecord, LeaseNotFoundError, never> {
  return id._tag === "leaseId"
    ? readLeaseByLeaseId(state, id.value)
    : readLeaseByDispatchId(state, id.value);
}

function rejectTerminalBinding(
  leaseId: LeaseId,
  state: LeaseState,
): Effect.Effect<void, LeaseInvalidError, never> {
  return TERMINAL_BIND_STATES.includes(state)
    ? Effect.fail(
        invalidLeaseState(
          leaseId,
          state,
          BINDABLE_LEASE_STATES,
          "bindToConnection",
        ),
      )
    : Effect.void;
}

function bindLeaseToConnection(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  connId: ConnectionId,
): Effect.Effect<void, LeaseInvalidError | LeaseNotFoundError, never> {
  return Effect.gen(function* () {
    const entry = yield* getExistingLeaseEntry(state, leaseId);
    yield* rejectTerminalBinding(leaseId, entry.record.state);
    if (entry.record.binding.recipientConnectionId === connId) return;
    const next: LeaseRecord = {
      ...entry.record,
      binding: { ...entry.record.binding, recipientConnectionId: connId },
    };
    yield* replaceEntry(state, leaseId, { ...entry, record: next });
  });
}

function emitReleaseForLease(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  verdict: LeaseVerdict,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const entries = yield* Ref.get(state.entriesRef);
    const entry = entries.get(leaseId);
    if (!entry) return;
    yield* emitDispatchRelease(state, entry.record, verdict);
  });
}

function attachRoundTripFiberToLease(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  fiber: Fiber.RuntimeFiber<unknown, unknown>,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const entries = yield* Ref.get(state.entriesRef);
    const entry = entries.get(leaseId);
    if (!entry || entry.record.state !== "PENDING") return;
    yield* replaceEntry(state, leaseId, { ...entry, roundTripFiber: fiber });
  });
}

function leaseTargetsForConnection(
  entries: ReadonlyMap<LeaseId, LeaseEntry>,
  connId: ConnectionId,
): ReadonlyArray<LeaseConnectionTarget> {
  return Array.from(entries, ([leaseId, entry]) => ({
    leaseId,
    entry,
  })).filter(
    ({ entry }) => entry.record.binding.recipientConnectionId === connId,
  );
}

function abandonPendingLease(
  state: LeaseRegistryState,
  target: LeaseConnectionTarget,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const { leaseId, entry } = target;
    const abandonedRecord: LeaseRecord = {
      ...entry.record,
      state: "ABANDONED",
      resolvedAt: new Date().toISOString(),
    };
    yield* replaceEntry(state, leaseId, {
      record: abandonedRecord,
      ttlFiber: null,
      roundTripFiber: null,
    });
    const roundTripFiber = entry.roundTripFiber;
    if (roundTripFiber) {
      yield* Fiber.interruptFork(roundTripFiber);
    }
    yield* scheduleRetention(state, leaseId, abandonedRecord.dispatchId);
  });
}

function expireLeaseOnDisconnect(
  state: LeaseRegistryState,
  target: LeaseConnectionTarget,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const { leaseId, entry } = target;
    const ttlFiber = entry.ttlFiber;
    if (ttlFiber) {
      yield* Fiber.interruptFork(ttlFiber);
    }
    const expiredAt = new Date().toISOString();
    const expiredRecord: LeaseRecord = {
      ...entry.record,
      state: "EXPIRED",
      expiredAt,
    };
    yield* replaceEntry(state, leaseId, {
      record: expiredRecord,
      ttlFiber: null,
      roundTripFiber: null,
    });
    yield* emitDispatchesExpired(state, expiredRecord, expiredAt);
    yield* scheduleRetention(state, leaseId, expiredRecord.dispatchId);
  });
}

function abandonLeaseForConnection(
  state: LeaseRegistryState,
  target: LeaseConnectionTarget,
): Effect.Effect<void, never, never> {
  const leaseState = target.entry.record.state;
  if (leaseState === "PENDING") return abandonPendingLease(state, target);
  if (isTtlExpirableState(leaseState)) {
    return expireLeaseOnDisconnect(state, target);
  }
  return Effect.void;
}

function abandonConnectionLeases(
  state: LeaseRegistryState,
  connId: ConnectionId,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const entries = yield* Ref.get(state.entriesRef);
    const targets = leaseTargetsForConnection(entries, connId);
    yield* Effect.forEach(
      targets,
      (target) => abandonLeaseForConnection(state, target),
      { concurrency: 1, discard: true },
    );
  }).pipe(Effect.asVoid);
}

function makeLeaseRegistryFromState(state: LeaseRegistryState): LeaseRegistry {
  return {
    mint: (ctx) => mintLease(state, ctx),
    resolve: (leaseId, verdict) => resolveLease(state, leaseId, verdict),
    claim: (leaseId) => claimLease(state, leaseId),
    read: (id) => readLease(state, id),
    bindToConnection: (leaseId, connId) =>
      bindLeaseToConnection(state, leaseId, connId),
    abandon: (connId) => abandonConnectionLeases(state, connId),
    attachRoundTripFiber: (leaseId, fiber) =>
      attachRoundTripFiberToLease(state, leaseId, fiber),
    emitRelease: (leaseId, verdict) =>
      emitReleaseForLease(state, leaseId, verdict),
  };
}

/**
 * Construct the registry. The constructor is the only public factory
 * — `LeaseRegistry` is referenced as an interface from call sites.
 *
 * Implementation: a `Ref&lt;Map&lt;LeaseId, LeaseEntry>>` plus a per-lease
 * scheduled TTL fiber (Effect-managed; safe to interrupt). Every state
 * transition is a `Ref.modify` predicate that returns the new entry +
 * a description of the side-effect (notification to emit, fiber to
 * cancel). The side-effects run AFTER the predicate commits — so the
 * state change is visible to concurrent readers before the
 * notification fires, satisfying the "first writer wins" invariant.
 */
export function makeLeaseRegistry(
  deps: LeaseRegistryDeps,
): Effect.Effect<LeaseRegistry, never, never> {
  return Effect.gen(function* () {
    const entriesRef = yield* Ref.make<ReadonlyMap<LeaseId, LeaseEntry>>(
      new Map(),
    );
    const dispatchIndexRef = yield* Ref.make<ReadonlyMap<DispatchId, LeaseId>>(
      new Map(),
    );
    return makeLeaseRegistryFromState({ deps, entriesRef, dispatchIndexRef });
  }).pipe(Effect.withSpan("makeLeaseRegistry"));
}
