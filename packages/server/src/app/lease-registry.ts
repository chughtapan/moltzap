import { Data, Effect, Fiber, Ref } from "effect";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId, MessageId, TaskId } from "@moltzap/protocol/task";
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
interface LeaseBindingTuple {
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
type LeaseVerdict =
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
interface LeaseMintContext {
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
interface LeaseMintResult {
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
class LeaseNotFoundError extends Data.TaggedError("LeaseNotFoundError")<{
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
interface Claim {
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
    connId: string,
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
  abandon(connId: string): Effect.Effect<void, never, never>;

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
    tmEndpointAddress: record.binding.tmEndpointAddress,
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

    const writeFrame = (
      connId: string,
      raw: string,
    ): Effect.Effect<void, never, never> => {
      const conn = deps.connections.get(connId);
      if (!conn) {
        // Connection is gone — log + drop. The recipient's reconnect
        // contract replays from server state via `dispatches/get`.
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
    };

    const emitDispatchRelease = (
      record: LeaseRecord,
      verdict: LeaseVerdict,
    ): Effect.Effect<void, never, never> => {
      const wire = leaseVerdictToWire(verdict);
      if (wire === null) return Effect.void;
      const params = {
        dispatchId: record.dispatchId,
        leaseId: record.leaseId,
        verdict: wire,
        ...(verdict._tag === "grant" && verdict.leaseTimeoutMs !== undefined
          ? { leaseTimeoutMs: verdict.leaseTimeoutMs }
          : {}),
      };
      const frame = DispatchRelease.encode(params);
      return writeFrame(
        record.binding.recipientConnectionId,
        JSON.stringify(frame),
      );
    };

    const emitDispatchesConsumed = (
      record: LeaseRecord,
      messageId: MessageId,
      consumedAt: string,
    ): Effect.Effect<void, never, never> => {
      const frame = DispatchesConsumed.encode({
        dispatchId: record.dispatchId,
        leaseId: record.leaseId,
        conversationId: record.binding.conversationId,
        messageId,
        consumedAt,
      });
      return writeFrame(
        record.binding.moderatorConnectionId,
        JSON.stringify(frame),
      );
    };

    const emitDispatchesExpired = (
      record: LeaseRecord,
      expiredAt: string,
    ): Effect.Effect<void, never, never> => {
      const frame = DispatchesExpired.encode({
        dispatchId: record.dispatchId,
        leaseId: record.leaseId,
        conversationId: record.binding.conversationId,
        expiredAt,
      });
      return writeFrame(
        record.binding.moderatorConnectionId,
        JSON.stringify(frame),
      );
    };

    const replaceEntry = (
      leaseId: LeaseId,
      next: LeaseEntry,
    ): Effect.Effect<void, never, never> =>
      Ref.update(entriesRef, (m) => {
        const out = new Map(m);
        out.set(leaseId, next);
        return out;
      });

    const removeEntry = (
      leaseId: LeaseId,
      dispatchId: DispatchId,
    ): Effect.Effect<void, never, never> =>
      Effect.zip(
        Ref.update(entriesRef, (m) => {
          const out = new Map(m);
          out.delete(leaseId);
          return out;
        }),
        Ref.update(dispatchIndexRef, (m) => {
          const out = new Map(m);
          out.delete(dispatchId);
          return out;
        }),
      ).pipe(Effect.asVoid);

    const scheduleRetention = (
      leaseId: LeaseId,
      dispatchId: DispatchId,
    ): Effect.Effect<void, never, never> =>
      // `forkDaemon` (not `fork`) — retention sweeps must outlive the
      // calling Effect's Scope. The Effect.fork variant ties the child
      // fiber to the parent's `Scope`, which on the connection-close
      // path is short-lived (the WS handler's onExit). A scope-bound
      // 5-minute sleep blocked the test runtime's afterAll teardown
      // because the parent scope kept the child alive past the
      // server's appScope close. Daemon fibers are killed only when
      // the runtime itself disposes — exactly the lifetime we want
      // for retention.
      Effect.forkDaemon(
        Effect.sleep(`${deps.leaseRetentionMs} millis`).pipe(
          Effect.flatMap(() => removeEntry(leaseId, dispatchId)),
        ),
      ).pipe(Effect.asVoid);

    const scheduleTtl = (
      leaseId: LeaseId,
      timeoutMs: number,
    ): Effect.Effect<Fiber.RuntimeFiber<unknown, unknown>, never, never> =>
      Effect.forkDaemon(
        Effect.gen(function* () {
          yield* Effect.sleep(`${timeoutMs} millis`);
          // TTL fired: try to advance GRANTED/HOLD → EXPIRED. CLAIMED +
          // terminal states no-op (load-bearing rule 1).
          const current = yield* Ref.get(entriesRef);
          const entry = current.get(leaseId);
          if (!entry) return;
          if (
            entry.record.state !== "GRANTED" &&
            entry.record.state !== "HOLD"
          ) {
            return;
          }
          const expiredAt = new Date().toISOString();
          const nextRecord: LeaseRecord = {
            ...entry.record,
            state: "EXPIRED",
            expiredAt,
          };
          yield* replaceEntry(leaseId, {
            record: nextRecord,
            ttlFiber: null,
            roundTripFiber: null,
          });
          yield* emitDispatchesExpired(nextRecord, expiredAt);
          yield* scheduleRetention(leaseId, nextRecord.dispatchId);
        }),
      );

    const finalizeClaim = (leaseId: LeaseId, messageId: MessageId) =>
      Effect.gen(function* () {
        const cur = yield* Ref.get(entriesRef);
        const e = cur.get(leaseId);
        if (!e) {
          return yield* Effect.fail(
            new LeaseInvalidError({
              leaseId,
              state: "EXPIRED",
              expected: ["CLAIMED"],
              operation: "finalize",
            }),
          );
        }
        if (e.record.state !== "CLAIMED") {
          return yield* Effect.fail(
            new LeaseInvalidError({
              leaseId,
              state: e.record.state,
              expected: ["CLAIMED"],
              operation: "finalize",
            }),
          );
        }
        const consumedAt = new Date().toISOString();
        const consumedRecord: LeaseRecord = {
          ...e.record,
          state: "CONSUMED",
          consumedAt,
          consumedMessageId: messageId,
        };
        yield* replaceEntry(leaseId, {
          record: consumedRecord,
          ttlFiber: null,
          roundTripFiber: null,
        });
        yield* emitDispatchesConsumed(consumedRecord, messageId, consumedAt);
        yield* scheduleRetention(leaseId, consumedRecord.dispatchId);
      });

    const rescheduleRollbackTtl = (leaseId: LeaseId, e: LeaseEntry) => {
      if (e.record.leaseTimeoutMs === null) {
        return Effect.succeed(null);
      }
      return scheduleTtl(leaseId, e.record.leaseTimeoutMs);
    };

    const rollbackClaim = (leaseId: LeaseId) =>
      Effect.gen(function* () {
        const cur = yield* Ref.get(entriesRef);
        const e = cur.get(leaseId);
        if (!e) {
          return yield* Effect.fail(
            new LeaseInvalidError({
              leaseId,
              state: "EXPIRED",
              expected: ["CLAIMED"],
              operation: "rollback",
            }),
          );
        }
        if (e.record.state !== "CLAIMED") {
          return yield* Effect.fail(
            new LeaseInvalidError({
              leaseId,
              state: e.record.state,
              expected: ["CLAIMED"],
              operation: "rollback",
            }),
          );
        }
        const rolledBack: LeaseRecord = {
          ...e.record,
          state: "GRANTED",
        };
        // Reschedule TTL if one was originally configured.
        const newFiber = yield* rescheduleRollbackTtl(leaseId, e);
        yield* replaceEntry(leaseId, {
          record: rolledBack,
          ttlFiber: newFiber,
          roundTripFiber: null,
        });
      });

    const makeClaim = (leaseId: LeaseId): Claim => ({
      leaseId,
      finalize: (messageId) => finalizeClaim(leaseId, messageId),
      rollback: rollbackClaim(leaseId),
    });

    const registry: LeaseRegistry = {
      mint: (ctx) =>
        Effect.gen(function* () {
          const leaseId = crypto.randomUUID() as LeaseId;
          const dispatchId = crypto.randomUUID() as DispatchId;
          const mintedAt = new Date().toISOString();
          const record: LeaseRecord = {
            dispatchId,
            leaseId,
            binding: {
              recipientAgentId: ctx.recipientAgentId,
              recipientConnectionId: ctx.recipientConnectionId,
              moderatorConnectionId: ctx.moderatorConnectionId,
              taskId: ctx.taskId,
              conversationId: ctx.conversationId,
              tmEndpointAddress: ctx.tmEndpointAddress,
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
          const entry: LeaseEntry = {
            record,
            ttlFiber: null,
            roundTripFiber: null,
          };
          yield* Ref.update(entriesRef, setReadonlyMapValue(leaseId, entry));
          yield* Ref.update(
            dispatchIndexRef,
            setReadonlyMapValue(dispatchId, leaseId),
          );
          return { leaseId, dispatchId };
        }),

      resolve: (leaseId, verdict) =>
        Effect.gen(function* () {
          const entries = yield* Ref.get(entriesRef);
          const entry = entries.get(leaseId);
          if (!entry) {
            return yield* Effect.fail(
              new LeaseNotFoundError({ id: leaseId, kind: "leaseId" }),
            );
          }
          if (entry.record.state !== "PENDING") {
            return yield* Effect.fail(
              new LeaseInvalidError({
                leaseId,
                state: entry.record.state,
                expected: ["PENDING"],
                operation: "resolve",
              }),
            );
          }
          const resolvedAt = new Date().toISOString();
          const nextState = leaseStateForVerdict(verdict);
          const leaseTimeoutMs = leaseTimeoutForVerdict(verdict);
          const nextRecord: LeaseRecord = {
            ...entry.record,
            state: nextState,
            verdict,
            resolvedAt,
            leaseTimeoutMs,
          };
          let ttlFiber: Fiber.RuntimeFiber<unknown, unknown> | null = null;
          // Schedule TTL for GRANTED + HOLD if leaseTimeoutMs supplied.
          if (
            (nextState === "GRANTED" || nextState === "HOLD") &&
            leaseTimeoutMs !== null
          ) {
            ttlFiber = yield* scheduleTtl(leaseId, leaseTimeoutMs);
          }
          // Resolve clears the round-trip-fiber slot — the forked fiber
          // is the one calling resolve, so by definition it has finished
          // its hook call by the time we reach this point.
          yield* replaceEntry(leaseId, {
            record: nextRecord,
            ttlFiber,
            roundTripFiber: null,
          });
          yield* emitDispatchRelease(nextRecord, verdict);
          // Terminal: schedule retention sweep so the record ages out.
          if (nextState === "DENIED") {
            yield* scheduleRetention(leaseId, nextRecord.dispatchId);
          }
        }),

      claim: (leaseId) =>
        Effect.gen(function* () {
          const entries = yield* Ref.get(entriesRef);
          const entry = entries.get(leaseId);
          if (!entry) {
            return yield* Effect.fail(
              new LeaseNotFoundError({ id: leaseId, kind: "leaseId" }),
            );
          }
          if (entry.record.state !== "GRANTED") {
            return yield* Effect.fail(
              new LeaseInvalidError({
                leaseId,
                state: entry.record.state,
                expected: ["GRANTED"],
                operation: "claim",
              }),
            );
          }
          // Atomic GRANTED → CLAIMED. Cancel the post-grant TTL — the
          // in-flight insert owns the lease now.
          if (entry.ttlFiber) {
            yield* Fiber.interrupt(entry.ttlFiber);
          }
          const claimedRecord: LeaseRecord = {
            ...entry.record,
            state: "CLAIMED",
          };
          yield* replaceEntry(leaseId, {
            record: claimedRecord,
            ttlFiber: null,
            roundTripFiber: null,
          });

          return makeClaim(leaseId);
        }),

      read: (id) =>
        Effect.gen(function* () {
          const entries = yield* Ref.get(entriesRef);
          if (id._tag === "leaseId") {
            const entry = entries.get(id.value);
            if (!entry) {
              return yield* Effect.fail(
                new LeaseNotFoundError({ id: id.value, kind: "leaseId" }),
              );
            }
            return entry.record;
          }
          const dispatches = yield* Ref.get(dispatchIndexRef);
          const leaseId = dispatches.get(id.value);
          if (!leaseId) {
            return yield* Effect.fail(
              new LeaseNotFoundError({ id: id.value, kind: "dispatchId" }),
            );
          }
          const entry = entries.get(leaseId);
          if (!entry) {
            return yield* Effect.fail(
              new LeaseNotFoundError({ id: id.value, kind: "dispatchId" }),
            );
          }
          return entry.record;
        }),

      bindToConnection: (leaseId, connId) =>
        Effect.gen(function* () {
          const entries = yield* Ref.get(entriesRef);
          const entry = entries.get(leaseId);
          if (!entry) {
            return yield* Effect.fail(
              new LeaseNotFoundError({ id: leaseId, kind: "leaseId" }),
            );
          }
          // Reject on terminal states; bind is idempotent on same connId.
          if (
            entry.record.state === "CONSUMED" ||
            entry.record.state === "DENIED" ||
            entry.record.state === "EXPIRED" ||
            entry.record.state === "ABANDONED"
          ) {
            return yield* Effect.fail(
              new LeaseInvalidError({
                leaseId,
                state: entry.record.state,
                expected: ["PENDING", "GRANTED", "HOLD", "CLAIMED"],
                operation: "bindToConnection",
              }),
            );
          }
          if (entry.record.binding.recipientConnectionId === connId) {
            return; // idempotent
          }
          const next: LeaseRecord = {
            ...entry.record,
            binding: {
              ...entry.record.binding,
              recipientConnectionId: connId,
            },
          };
          yield* replaceEntry(leaseId, { ...entry, record: next });
        }),

      emitRelease: (leaseId, verdict) =>
        Effect.gen(function* () {
          const entries = yield* Ref.get(entriesRef);
          const entry = entries.get(leaseId);
          if (!entry) return; // logged-and-dropped; no-throw contract
          yield* emitDispatchRelease(entry.record, verdict);
        }),

      attachRoundTripFiber: (leaseId, fiber) =>
        Effect.gen(function* () {
          const entries = yield* Ref.get(entriesRef);
          const entry = entries.get(leaseId);
          if (!entry) return;
          // Only meaningful while the lease is still PENDING. After
          // resolve fires, the slot is cleared and `abandon` no-ops.
          if (entry.record.state !== "PENDING") return;
          yield* replaceEntry(leaseId, { ...entry, roundTripFiber: fiber });
        }),

      abandon: (connId) =>
        Effect.gen(function* () {
          const entries = yield* Ref.get(entriesRef);
          // Snapshot the leases bound to this connection. We mutate
          // `entriesRef` per-lease below, but the snapshot is the work
          // list — leases minted after this call are unrelated.
          const targets: Array<{
            readonly leaseId: LeaseId;
            readonly entry: LeaseEntry;
          }> = [];
          for (const [leaseId, entry] of entries) {
            if (entry.record.binding.recipientConnectionId === connId) {
              targets.push({ leaseId, entry });
            }
          }
          for (const { leaseId, entry } of targets) {
            const state = entry.record.state;
            if (state === "PENDING") {
              // PENDING → ABANDONED. Cancel the forked moderator round-
              // trip; do NOT emit `dispatch/release` (recipient is gone).
              // `Fiber.interruptFork` does not await the interrupt —
              // critical for the disconnect path because the round-trip
              // fiber may be awaiting a never-resolving in-process hook
              // promise; awaiting interrupt would block the disconnect
              // finalizer.
              const abandonedRecord: LeaseRecord = {
                ...entry.record,
                state: "ABANDONED",
                resolvedAt: new Date().toISOString(),
              };
              yield* replaceEntry(leaseId, {
                record: abandonedRecord,
                ttlFiber: null,
                roundTripFiber: null,
              });
              if (entry.roundTripFiber) {
                yield* Fiber.interruptFork(entry.roundTripFiber);
              }
              yield* scheduleRetention(leaseId, abandonedRecord.dispatchId);
              continue;
            }
            if (state === "GRANTED" || state === "HOLD") {
              // GRANTED/HOLD → EXPIRED-on-disconnect (terminal).
              // Cancel the post-grant TTL fiber; emit `dispatches/expired`
              // to the moderator (the recipient is gone, so the lease
              // cannot be consumed; observability is moderator-only).
              if (entry.ttlFiber) {
                yield* Fiber.interruptFork(entry.ttlFiber);
              }
              const expiredAt = new Date().toISOString();
              const expiredRecord: LeaseRecord = {
                ...entry.record,
                state: "EXPIRED",
                expiredAt,
              };
              yield* replaceEntry(leaseId, {
                record: expiredRecord,
                ttlFiber: null,
                roundTripFiber: null,
              });
              yield* emitDispatchesExpired(expiredRecord, expiredAt);
              yield* scheduleRetention(leaseId, expiredRecord.dispatchId);
            }
            // CLAIMED is the load-bearing no-op (rule 2): an in-flight
            // `messages/send` owns the lease via Effect.acquireUseRelease;
            // the release-arm of the wrapper is responsible for finalize
            // or rollback. Disconnecting mid-insert here MUST NOT roll
            // back a committed durable row.
            //
            // CONSUMED / DENIED / EXPIRED / ABANDONED are
            // terminal-or-near-terminal; nothing to do. Their retention
            // sweep was already scheduled at the resolving transition.
          }
        }),
    };

    return registry;
  }).pipe(Effect.withSpan("makeLeaseRegistry"));
}
