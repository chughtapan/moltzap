import {
  Data,
  Deferred,
  Effect,
  Either,
  Fiber,
  Option,
  Ref,
  Schema,
} from "effect";
import type { AgentId, AppId } from "@moltzap/protocol/identity";
import type { ConnectionId } from "@moltzap/protocol/socket";
import type { ConversationId, MessageId } from "@moltzap/protocol/conversation";
import type { TaskId } from "@moltzap/protocol/task";
import type {
  DispatchLeaseGet,
  DispatchId,
} from "@moltzap/protocol/message/dispatch";
import type { ResultOf } from "@moltzap/protocol/rpc";
import {
  DispatchId as DispatchIdSchema,
  LeaseId as LeaseIdSchema,
  DispatchRelease,
  DispatchLeaseConsumed,
  DispatchLeaseExpired,
} from "@moltzap/protocol/message/dispatch";
import type { LeaseId } from "@moltzap/protocol/message/dispatch";
import type { NotificationParamsOf } from "@moltzap/protocol/rpc";
import type { AnyNotificationDefinition } from "@moltzap/protocol/socket/catalog";
import type { ConnectionManager } from "#socket";
import type { LeaseTransitionObserver } from "#network/presence";

/** Wire-side LeaseRecord shape (flat). */
type LeaseRecordWire = ResultOf<typeof DispatchLeaseGet>["lease"];
const decodeDispatchId = Schema.decodeUnknownSync(DispatchIdSchema);
const decodeLeaseId = Schema.decodeUnknownSync(LeaseIdSchema);

/**
 * Lease registry — server-local admission state. An off-wire state
 * machine the server walks deterministically as moderator verdicts,
 * durable inserts, TTLs, and connection closures arrive.
 *
 * Invariants:
 *
 * - Every public method returns `Effect&lt;T, E, R>` with a typed error
 *   channel. `Promise&lt;T>` is forbidden on this surface.
 * - State transitions are atomic via `Ref.modify` (first-writer-wins).
 *   The state machine below names every transition.
 * - Lease and dispatch ids are branded (`LeaseId` / `DispatchId` from
 *   `@moltzap/protocol`); raw strings cannot be confused at call sites.
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
 *           │ connection-close                 │                   └─────────────▶ GRANTED
 *           ├────────────▶ ABANDONED           │
 *           │ moderator timeout                │
 *           └─synthesize deny─▶ DENIED         │
 *                                              │ connection-close
 *                                              └────────────▶ EXPIRED-on-disconnect
 *                                                              (terminal)
 * ```
 *
 * Only a GRANTED lease carrying `leaseTimeoutMs` owns a TTL. HOLD has no
 * timeout in the wire verdict and remains until recipient disconnect or
 * registry shutdown. CLAIMED and terminal states skip TTL.
 *
 * Two load-bearing rules:
 *
 * 1. **TTL skip on CLAIMED.** The TTL transition GRANTED → EXPIRED is
 *    a `Ref.modify` predicate that is a no-op on CLAIMED state. Only
 *    `finalize` or `rollback` leaves CLAIMED. Without this rule, a
 *    TTL firing mid-`messageService.sendInsert` would expire the
 *    lease while the durable row commits — `app/dispatch/lease-consumed`
 *    would never fire and the moderator's view would be inconsistent
 *    with the database.
 *
 * 2. **Connection close no-op on CLAIMED.** Recipient disconnect mid-
 *    insert MUST NOT roll back the lease. The in-flight
 *    `agent/message/send` owns the lease via `Effect.acquireUseRelease`
 *    in the messages handler; the close finalizer waits for the
 *    wrapped insert+finalize/rollback to complete before draining
 *    its own state. Without this rule, a disconnect mid-insert
 *    rolls back a committed durable row and a duplicate retry can
 *    create a duplicate message.
 *
 * Terminal states (CONSUMED / DENIED / EXPIRED / ABANDONED) age out
 * of the registry on the same `leaseRetentionMs` clock.
 */

/**
 * Audit binding recorded at `mint` time. Used by `app/dispatch/lease/get`
 * scope-enforcement, moderator observability, and connection-close cleanup.
 * Once recorded, the binding is immutable for the lease's lifetime.
 */
export interface ModeratorBoundLeaseBinding {
  readonly _tag: "ModeratorBound";
  readonly recipientAgentId: AgentId;
  readonly recipientConnectionId: ConnectionId;
  readonly conversationId: ConversationId;
  readonly moderatorConnectionId: ConnectionId;
  readonly taskId: TaskId;
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
 * Snapshot of a lease for `app/dispatch/lease/get` and observability tests.
 * Mirrors the wire `LeaseRecordSchema` shape; ISO-8601 timestamps for
 * cross-boundary stability.
 */
export interface LeaseRecord {
  readonly dispatchId: DispatchId;
  readonly leaseId: LeaseId;
  readonly binding: ModeratorBoundLeaseBinding;
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
 * surface a precise wire-error code, e.g. typed-CONSUMED /
 * typed-EXPIRED) and `expected` carries the set of states the
 * operation would have accepted.
 */
export class LeaseInvalidError extends Data.TaggedError("LeaseInvalidError")<{
  readonly leaseId: LeaseId;
  readonly state: LeaseState;
  readonly expected: ReadonlyArray<LeaseState>;
  readonly operation: "resolve" | "claim" | "finalize" | "rollback" | "read";
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

  /**
   * CLAIMED → CONSUMED. Calling twice on the same handle returns a typed
   * `LeaseInvalidError` because the first call already left CLAIMED.
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
 * Public contract of the lease registry. One instance per server lifetime,
 * shared by dispatch admission and message send. Backed by an in-process
 * `Ref&lt;LeaseRegistryData>` containing entries, dispatch index, and the closed
 * flag — no DB row. State transitions are atomic via `Ref.modify`.
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
 *   GRANTED --> CLAIMED : agent/message/send claim
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
 *   participant DA as DispatchAdmissionService
 *   participant LR as LeaseRegistry
 *   participant Mod as Moderator
 *   participant MS as MessageService
 *
 *   Recv->>DA: agent/dispatch/request (C→S)
 *   DA->>LR: mint(binding) — PENDING
 *   LR-->>DA: {leaseId, dispatchId}
 *   DA-->>Recv: ack returned immediately
 *   DA->>Mod: Effect.forkDaemon — app/dispatch/authorize
 *   Mod-->>DA: verdict
 *   DA->>LR: resolve(leaseId, verdict) — GRANTED | DENIED | HOLD
 *   LR->>Recv: agent/dispatch/released {verdict}
 *   Recv->>MS: agent/message/send with dispatchLeaseId
 *   MS->>LR: claim(leaseId) — GRANTED → CLAIMED
 *   Note over MS: Effect.acquireUseRelease — use sendInsert returns carrier — release on Exit success claim.finalize CLAIMED → CONSUMED, on Exit failure claim.rollback CLAIMED → GRANTED
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
 * Each timed GRANTED lease owns one daemon TTL fiber. The fiber is bound to
 * the immutable record version that created it, so a stale pre-rollback timer
 * cannot expire a newer GRANTED epoch. The timeout comes from the grant
 * verdict's `leaseTimeoutMs`.
 */
export interface LeaseRegistry {
  /**
   * Mint a new PENDING lease. Synchronous (`Effect&lt;..., never>`) — the
   * registry is in-process. Records the moderator-bound binding for audit,
   * `app/dispatch/lease/get`, and connection-close cleanup.
   *
   * Both ids are minted via `crypto.randomUUID()`; the brand on
   * `LeaseId` / `DispatchId` keeps them disjoint at every call site.
   */
  mint(
    binding: ModeratorBoundLeaseBinding,
  ): Effect.Effect<LeaseMintResult, never, never>;

  /**
   * Settle a PENDING lease into a terminal-or-near-terminal state via
   * the moderator's verdict (or a synthesized verdict for app-unavailable /
   * moderator-timeout). First writer wins via `Ref.modify`; second `resolve`
   * against the same lease fails with `LeaseInvalidError`. Internally calls the
   * module-local `emitDispatchRelease` helper so `agent/dispatch/released` fires on
   * every resolution path uniformly.
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
   * Snapshot read for `app/dispatch/lease/get`. Includes the live `leaseId` —
   * the moderator is the authority for the lease, so live-id visibility
   * is in-scope.
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
   * Connection-close cleanup. Called from the WS disconnect-hook chain
   * with the closing connection id. Iterates leases bound to that
   * recipientConnectionId and applies these transitions:
   *
   * - **PENDING → ABANDONED**: cancels the forked moderator round-trip
   *   (its `resolve` call against the now-ABANDONED lease returns
   *   `LeaseInvalidError(state=ABANDONED, expected=PENDING)`, which the
   *   forked fiber catches and discards). No `agent/dispatch/released`
   *   notification fires (the recipient is gone).
   *
   * - **GRANTED / HOLD → EXPIRED-on-disconnect**: terminal state; emits
   *   `app/dispatch/lease-expired` to the moderator. Cancels the post-grant TTL
   *   fiber. The recipient won't observe; the moderator's view stays
   *   consistent.
   *
   * - **CLAIMED → no-op (load-bearing rule 2)**: a CLAIMED lease has an
   *   in-flight `agent/message/send` owning it via `Effect.acquireUseRelease`.
   *   Disconnecting mid-insert MUST NOT roll back the lease — the
   *   release-arm of the acquireUseRelease is responsible. Otherwise a
   *   committed durable row could be retried into a duplicate.
   *
   * - **DENIED / EXPIRED / ABANDONED / CONSUMED**: no-op (already terminal;
   *   no recipient-binding work to do).
   *
   * The matching transitions commit as one atomic batch. Notification
   * failures are absorbed so disconnect cleanup always completes; the public
   * error channel is `never`.
   */
  abandon(connId: ConnectionId): Effect.Effect<void, never, never>;

  /**
   * Internal — record the forked moderator round-trip fiber so
   * {@link abandon} can interrupt it on recipient disconnect. The
   * caller forks the round-trip immediately after `mint`; the registry
   * interrupts the fiber when the binding's recipient connection closes
   * (PENDING → ABANDONED). If the child already resolved the lease, attachment
   * leaves that winning child alive to finish its post-commit work. If the
   * lease was abandoned or removed, attachment interrupts the orphaned child.
   * Reattaching the same fiber is idempotent.
   */
  attachRoundTripFiber(
    leaseId: LeaseId,
    fiber: Fiber.RuntimeFiber<unknown, unknown>,
  ): Effect.Effect<void, never, never>;

  /**
   * Deterministic shutdown drain — invoked by `CoreApp.close`
   * (`core/app.ts -> closeCoreAppEffect`) BEFORE `Scope.close(appScope)`.
   *
   * Closing the app scope interrupts every per-connection WebSocket fiber.
   * Each interrupted fiber runs its disconnect cleanup
   * (`MoltZapServer`/`moltzap/server-socket.ts` close cleanup) in an UNINTERRUPTIBLE
   * `onExit` region, and that cleanup calls {@link abandon}. For a recipient
   * connection holding a GRANTED lease, `abandon` emits a `app/dispatch/lease-expired`
   * frame to the MODERATOR connection via {@link fireNotification}. When the
   * moderator socket is being torn down concurrently its write-latch is
   * closed, so the cross-connection write SUSPENDS forever — inside the
   * uninterruptible region — and `Scope.close` blocks awaiting that
   * fiber. That is the teardown deadlock this method prevents.
   *
   * `shutdown` breaks the deadlock at its source: it flips the registry into
   * a closed state and completes a shared shutdown signal. New notifications
   * drop, in-flight notifications and retention sleepers lose their race with
   * that signal, and live TTL/round-trip fibers are interrupted.
   * Idempotent; safe to call when no leases are live. Error channel `never` —
   * shutdown is best-effort.
   */
  shutdown(): Effect.Effect<void, never, never>;
}

/**
 * Constructor dependencies for the lease registry.
 * - `connections`: looked up by the internal `emitDispatchRelease`
 *   helper to find the recipient and at `app/dispatch/lease-consumed` /
 *   `app/dispatch/lease-expired` emission to find the moderator's connection.
 * - `leaseRetentionMs`: terminal-state retention window (CONSUMED /
 *   DENIED / EXPIRED / ABANDONED). A GRANTED lease may separately carry the
 *   verdict's `leaseTimeoutMs`.
 * - `transitionObserver`: called at every transition that crosses the
 *   lease's "active for presence" boundary (PENDING → GRANTED, exits
 *   from GRANTED|CLAIMED). Feeds presence emission. **Required, not
 *   optional** — every constructor call site supplies a value, either
 *   the real `PresenceService` (production) or the
 *   `noopLeaseTransitionObserver` constant (tests that do not exercise
 *   presence). Required-not-default is structurally tighter: TypeScript
 *   surfaces missing wiring at the call site. See
 *   `network/presence → LeaseTransitionObserver` for the call shape; the
 *   per-transition contract lives in `network/presence → PresenceService`.
 */
export interface LeaseRegistryDeps {
  readonly connections: ConnectionManager;
  readonly leaseRetentionMs: number;
  readonly transitionObserver: LeaseTransitionObserver;
}

/**
 * Internal entry — wraps the public `LeaseRecord` plus the recipient-
 * connection binding needed for `agent/dispatch/released` fan-out and the
 * scheduled fiber for the post-grant TTL.
 */
interface LeaseEntry {
  readonly record: LeaseRecord;
  readonly ttlFiber: Fiber.RuntimeFiber<unknown, unknown> | null;

  /**
   * Forked moderator round-trip fiber. Attached by
   * {@link LeaseRegistry.attachRoundTripFiber} immediately after the
   * caller forks. Interrupted on PENDING → ABANDONED so the in-flight
   * app/dispatch/authorize hook is cancelled rather than leaking until
   * timeout. Null after the fiber completes naturally (resolve fired)
   * or the lease left PENDING.
   */
  readonly roundTripFiber: Fiber.RuntimeFiber<unknown, unknown> | null;
}

interface LeaseRegistryData {
  readonly entries: ReadonlyMap<LeaseId, LeaseEntry>;
  readonly dispatchIndex: ReadonlyMap<DispatchId, LeaseId>;

  /**
   * Set by {@link shutdownRegistry} at `CoreApp.close`. Once `true`, new
   * registry state cannot be repopulated and notifications are dropped.
   */
  readonly closed: boolean;
}

interface LeaseRegistryState {
  readonly deps: LeaseRegistryDeps;
  readonly dataRef: Ref.Ref<LeaseRegistryData>;
  /** Cancels in-flight notification and retention effects at shutdown. */
  readonly shutdownSignal: Deferred.Deferred<void>;

  /**
   * `Ref.modify` makes each state change atomic. This permit additionally
   * serializes a state commit with its presence observer callback, preventing
   * a concurrent begin/end transition from overtaking that callback. Network
   * notifications and fiber interruption stay outside the permit.
   */
  readonly transitionPermit: Effect.Semaphore;
}

function withLeaseEntry(
  data: LeaseRegistryData,
  leaseId: LeaseId,
  entry: LeaseEntry,
): LeaseRegistryData {
  const entries = new Map(data.entries);
  entries.set(leaseId, entry);
  return { ...data, entries };
}

function modifyRegistry<A, E>(
  state: LeaseRegistryState,
  transition: (
    data: LeaseRegistryData,
  ) => readonly [Either.Either<A, E>, LeaseRegistryData],
): Effect.Effect<A, E, never> {
  return Ref.modify(state.dataRef, transition).pipe(
    Effect.flatMap(
      Either.match({
        onLeft: (error) => Effect.fail(error),
        onRight: (value) => Effect.succeed(value),
      }),
    ),
  );
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
 * Translation point between the in-process nested `LeaseRecord` and the wire
 * `LeaseRecordSchema` shape.
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

function fireNotification<D extends AnyNotificationDefinition>(
  state: LeaseRegistryState,
  connId: ConnectionId,
  definition: D,
  params: NotificationParamsOf<D>,
): Effect.Effect<void, never, never> {
  // Once the registry is shutting down, every connection is being torn down
  // concurrently. Drop the notification deterministically — no consumer
  // remains at shutdown.
  return Ref.get(state.dataRef).pipe(
    Effect.flatMap((data) => {
      if (data.closed) return Effect.void;
      return Effect.raceFirst(
        Effect.disconnect(
          fireNotificationToConnection(state, connId, definition, params),
        ),
        Deferred.await(state.shutdownSignal),
      ).pipe(Effect.asVoid);
    }),
  );
}

function fireNotificationToConnection<D extends AnyNotificationDefinition>(
  state: LeaseRegistryState,
  connId: ConnectionId,
  definition: D,
  params: NotificationParamsOf<D>,
): Effect.Effect<void, never, never> {
  return state.deps.connections.peek(connId).pipe(
    Effect.flatMap((connOpt) => {
      if (Option.isNone(connOpt)) {
        return Effect.logDebug(
          "lease-registry: target connection gone; dropping notification",
        ).pipe(Effect.annotateLogs({ connId }));
      }
      // Fire the notification over the target connection's reverse client; the
      // void result settles on the client's ack.
      return connOpt.value.originator
        .notify(definition, params)
        .pipe(
          Effect.catchAll((cause) =>
            Effect.logWarning("lease-registry: notification fire failed").pipe(
              Effect.annotateLogs({ connId, cause: String(cause) }),
            ),
          ),
        );
    }),
  );
}

function emitDispatchRelease(
  state: LeaseRegistryState,
  record: LeaseRecord,
  verdict: LeaseVerdict,
): Effect.Effect<void, never, never> {
  const wire = leaseVerdictToWire(verdict);
  if (wire === null) return Effect.void;
  return fireNotification(
    state,
    record.binding.recipientConnectionId,
    DispatchRelease,
    {
      dispatchId: record.dispatchId,
      leaseId: record.leaseId,
      verdict: wire,
      ...(verdict._tag === "grant" && verdict.leaseTimeoutMs !== undefined
        ? { leaseTimeoutMs: verdict.leaseTimeoutMs }
        : {}),
    },
  );
}

function emitDispatchLeaseConsumed(
  state: LeaseRegistryState,
  record: LeaseRecord,
  messageId: MessageId,
  consumedAt: string,
): Effect.Effect<void, never, never> {
  return fireNotification(
    state,
    record.binding.moderatorConnectionId,
    DispatchLeaseConsumed,
    {
      dispatchId: record.dispatchId,
      leaseId: record.leaseId,
      conversationId: record.binding.conversationId,
      messageId,
      consumedAt,
    },
  );
}

function emitDispatchLeaseExpired(
  state: LeaseRegistryState,
  record: LeaseRecord,
  expiredAt: string,
): Effect.Effect<void, never, never> {
  return fireNotification(
    state,
    record.binding.moderatorConnectionId,
    DispatchLeaseExpired,
    {
      dispatchId: record.dispatchId,
      leaseId: record.leaseId,
      conversationId: record.binding.conversationId,
      expiredAt,
    },
  );
}

function removeEntry(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  dispatchId: DispatchId,
): Effect.Effect<void, never, never> {
  return Ref.update(state.dataRef, (data) => {
    const entry = data.entries.get(leaseId);
    if (!entry || entry.record.dispatchId !== dispatchId) return data;
    const entries = new Map(data.entries);
    const dispatchIndex = new Map(data.dispatchIndex);
    entries.delete(leaseId);
    dispatchIndex.delete(dispatchId);
    return { ...data, entries, dispatchIndex };
  });
}

function scheduleRetention(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  dispatchId: DispatchId,
): Effect.Effect<void, never, never> {
  return Effect.forkDaemon(
    Effect.raceFirst(
      Effect.sleep(`${state.deps.leaseRetentionMs} millis`).pipe(
        Effect.flatMap(() => removeEntry(state, leaseId, dispatchId)),
      ),
      Deferred.await(state.shutdownSignal),
    ),
  ).pipe(Effect.asVoid);
}

function isTtlExpirableState(state: LeaseState): boolean {
  return state === "GRANTED";
}

function isDisconnectExpirableState(state: LeaseState): boolean {
  return state === "GRANTED" || state === "HOLD";
}

interface ExpiredLeaseTransition {
  readonly record: LeaseRecord;
  readonly expiredAt: string;
  readonly wasActive: boolean;
}

function observeLeaseActiveEnd(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  record: LeaseRecord,
): Effect.Effect<void, never, never> {
  return state.deps.transitionObserver.onLeaseActiveEnd(
    leaseId,
    record.binding.recipientAgentId,
    record.binding.recipientConnectionId,
  );
}

function commitTtlExpiry(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  expectedRecord: LeaseRecord,
): Effect.Effect<ExpiredLeaseTransition | null, never, never> {
  const expiredAt = new Date().toISOString();
  return modifyRegistry(state, (data) => {
    const entry = data.entries.get(leaseId);
    if (
      !entry ||
      entry.record !== expectedRecord ||
      !isTtlExpirableState(entry.record.state)
    ) {
      return [Either.right(null), data];
    }
    const record: LeaseRecord = {
      ...entry.record,
      state: "EXPIRED",
      expiredAt,
    };
    const nextEntry: LeaseEntry = {
      record,
      ttlFiber: null,
      roundTripFiber: null,
    };
    return [
      Either.right({
        record,
        expiredAt,
        wasActive: entry.record.state === "GRANTED",
      }),
      withLeaseEntry(data, leaseId, nextEntry),
    ];
  });
}

function expireLeaseFromTtl(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  expectedRecord: LeaseRecord,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const transition = yield* state.transitionPermit.withPermits(1)(
      Effect.gen(function* () {
        const committed = yield* commitTtlExpiry(
          state,
          leaseId,
          expectedRecord,
        );
        if (committed?.wasActive) {
          yield* observeLeaseActiveEnd(state, leaseId, committed.record);
        }
        return committed;
      }),
    );

    if (transition === null) return;
    yield* emitDispatchLeaseExpired(
      state,
      transition.record,
      transition.expiredAt,
    );
    yield* scheduleRetention(state, leaseId, transition.record.dispatchId);
  });
}

function scheduleTtl(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  timeoutMs: number,
  expectedRecord: LeaseRecord,
): Effect.Effect<Fiber.RuntimeFiber<unknown, unknown>, never, never> {
  return Effect.forkDaemon(
    Effect.sleep(`${timeoutMs} millis`).pipe(
      Effect.flatMap(() => expireLeaseFromTtl(state, leaseId, expectedRecord)),
    ),
  );
}

function attachTtlFiber(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  expectedRecord: LeaseRecord,
  fiber: Fiber.RuntimeFiber<unknown, unknown>,
): Effect.Effect<boolean, never, never> {
  return Ref.modify(state.dataRef, (data) => {
    const entry = data.entries.get(leaseId);
    if (!entry || entry.record !== expectedRecord || entry.ttlFiber !== null) {
      return [false, data];
    }
    return [true, withLeaseEntry(data, leaseId, { ...entry, ttlFiber: fiber })];
  });
}

function scheduleTtlForEntry(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  entry: LeaseEntry,
): Effect.Effect<void, never, never> {
  const timeoutMs = entry.record.leaseTimeoutMs;
  if (timeoutMs === null || !isTtlExpirableState(entry.record.state)) {
    return Effect.void;
  }
  return Effect.gen(function* () {
    const fiber = yield* scheduleTtl(state, leaseId, timeoutMs, entry.record);
    const attached = yield* attachTtlFiber(state, leaseId, entry.record, fiber);
    if (!attached) yield* Fiber.interruptFork(fiber);
  });
}

function getExistingLeaseEntry(
  state: LeaseRegistryState,
  leaseId: LeaseId,
): Effect.Effect<LeaseEntry, LeaseNotFoundError, never> {
  return Ref.get(state.dataRef).pipe(
    Effect.flatMap((data) => {
      const entry = data.entries.get(leaseId);
      return entry
        ? Effect.succeed(entry)
        : Effect.fail(leaseNotFound(leaseId, "leaseId"));
    }),
  );
}

function modifyClaimedEntry<A>(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  operation: "finalize" | "rollback",
  transition: (entry: LeaseEntry) => readonly [A, LeaseEntry],
): Effect.Effect<A, LeaseInvalidError, never> {
  return modifyRegistry(state, (data) => {
    const entry = data.entries.get(leaseId);
    const currentState = entry?.record.state ?? "EXPIRED";
    if (!entry || currentState !== "CLAIMED") {
      return [
        Either.left(
          invalidLeaseState(leaseId, currentState, ["CLAIMED"], operation),
        ),
        data,
      ];
    }
    const [value, nextEntry] = transition(entry);
    return [Either.right(value), withLeaseEntry(data, leaseId, nextEntry)];
  });
}

function finalizeClaim(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  messageId: MessageId,
): Effect.Effect<void, LeaseInvalidError, never> {
  return Effect.gen(function* () {
    const consumedAt = new Date().toISOString();
    const consumedRecord = yield* state.transitionPermit.withPermits(1)(
      Effect.gen(function* () {
        const record = yield* modifyClaimedEntry(
          state,
          leaseId,
          "finalize",
          (entry) => {
            const consumed: LeaseRecord = {
              ...entry.record,
              state: "CONSUMED",
              consumedAt,
              consumedMessageId: messageId,
            };
            return [
              consumed,
              { record: consumed, ttlFiber: null, roundTripFiber: null },
            ];
          },
        );
        yield* observeLeaseActiveEnd(state, leaseId, record);
        return record;
      }),
    );

    yield* emitDispatchLeaseConsumed(
      state,
      consumedRecord,
      messageId,
      consumedAt,
    );
    yield* scheduleRetention(state, leaseId, consumedRecord.dispatchId);
  });
}

function rollbackClaim(
  state: LeaseRegistryState,
  leaseId: LeaseId,
): Effect.Effect<void, LeaseInvalidError, never> {
  return Effect.gen(function* () {
    const grantedEntry = yield* state.transitionPermit.withPermits(1)(
      modifyClaimedEntry(state, leaseId, "rollback", (entry) => {
        const nextEntry: LeaseEntry = {
          record: { ...entry.record, state: "GRANTED" },
          ttlFiber: null,
          roundTripFiber: null,
        };
        return [nextEntry, nextEntry];
      }),
    );
    yield* scheduleTtlForEntry(state, leaseId, grantedEntry);
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
  binding: ModeratorBoundLeaseBinding,
  leaseId: LeaseId,
  dispatchId: DispatchId,
  mintedAt: string,
): LeaseRecord {
  return {
    dispatchId,
    leaseId,
    binding,
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
  binding: ModeratorBoundLeaseBinding,
): Effect.Effect<LeaseMintResult, never, never> {
  return Effect.gen(function* () {
    const leaseId = decodeLeaseId(crypto.randomUUID());
    const dispatchId = decodeDispatchId(crypto.randomUUID());
    const record = makeMintedLeaseRecord(
      binding,
      leaseId,
      dispatchId,
      new Date().toISOString(),
    );
    const entry: LeaseEntry = { record, ttlFiber: null, roundTripFiber: null };
    const inserted = yield* Ref.modify(state.dataRef, (data) => {
      if (data.closed) return [false, data];
      const entries = new Map(data.entries);
      const dispatchIndex = new Map(data.dispatchIndex);
      entries.set(leaseId, entry);
      dispatchIndex.set(dispatchId, leaseId);
      return [true, { ...data, entries, dispatchIndex }];
    });
    if (!inserted) return yield* Effect.interrupt;
    return { leaseId, dispatchId };
  });
}

function commitResolvedLease(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  verdict: LeaseVerdict,
): Effect.Effect<LeaseEntry, LeaseInvalidError | LeaseNotFoundError, never> {
  return modifyRegistry<LeaseEntry, LeaseInvalidError | LeaseNotFoundError>(
    state,
    (data) => {
      const entry = data.entries.get(leaseId);
      if (!entry) {
        return [Either.left(leaseNotFound(leaseId, "leaseId")), data];
      }
      if (entry.record.state !== "PENDING") {
        return [
          Either.left(
            invalidLeaseState(
              leaseId,
              entry.record.state,
              ["PENDING"],
              "resolve",
            ),
          ),
          data,
        ];
      }
      const record: LeaseRecord = {
        ...entry.record,
        state: leaseStateForVerdict(verdict),
        verdict,
        resolvedAt: new Date().toISOString(),
        leaseTimeoutMs: leaseTimeoutForVerdict(verdict),
      };
      const resolvedEntry: LeaseEntry = {
        record,
        ttlFiber: null,
        roundTripFiber: null,
      };
      return [
        Either.right(resolvedEntry),
        withLeaseEntry(data, leaseId, resolvedEntry),
      ];
    },
  );
}

function resolveLease(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  verdict: LeaseVerdict,
): Effect.Effect<void, LeaseInvalidError | LeaseNotFoundError, never> {
  return Effect.gen(function* () {
    const nextState = leaseStateForVerdict(verdict);
    const nextEntry = yield* state.transitionPermit.withPermits(1)(
      Effect.gen(function* () {
        const committed = yield* commitResolvedLease(state, leaseId, verdict);
        if (committed.record.state === "GRANTED") {
          yield* state.deps.transitionObserver.onLeaseActiveBegin(
            leaseId,
            committed.record.binding.recipientAgentId,
            committed.record.binding.recipientConnectionId,
          );
        }
        return committed;
      }),
    );

    yield* scheduleTtlForEntry(state, leaseId, nextEntry);
    yield* emitDispatchRelease(state, nextEntry.record, verdict);
    if (nextState === "DENIED") {
      yield* scheduleRetention(state, leaseId, nextEntry.record.dispatchId);
    }
  });
}

function commitClaimedLease(
  state: LeaseRegistryState,
  leaseId: LeaseId,
): Effect.Effect<
  Fiber.RuntimeFiber<unknown, unknown> | null,
  LeaseInvalidError | LeaseNotFoundError,
  never
> {
  return modifyRegistry<
    Fiber.RuntimeFiber<unknown, unknown> | null,
    LeaseInvalidError | LeaseNotFoundError
  >(state, (data) => {
    const entry = data.entries.get(leaseId);
    if (!entry) {
      return [Either.left(leaseNotFound(leaseId, "leaseId")), data];
    }
    if (entry.record.state !== "GRANTED") {
      return [
        Either.left(
          invalidLeaseState(leaseId, entry.record.state, ["GRANTED"], "claim"),
        ),
        data,
      ];
    }
    const claimedEntry: LeaseEntry = {
      record: { ...entry.record, state: "CLAIMED" },
      ttlFiber: null,
      roundTripFiber: null,
    };
    return [
      Either.right(entry.ttlFiber),
      withLeaseEntry(data, leaseId, claimedEntry),
    ];
  });
}

function claimLease(
  state: LeaseRegistryState,
  leaseId: LeaseId,
): Effect.Effect<Claim, LeaseInvalidError | LeaseNotFoundError, never> {
  return Effect.gen(function* () {
    const ttlFiber = yield* state.transitionPermit.withPermits(1)(
      commitClaimedLease(state, leaseId),
    );
    if (ttlFiber) yield* Fiber.interruptFork(ttlFiber);
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
    const data = yield* Ref.get(state.dataRef);
    const leaseId = data.dispatchIndex.get(dispatchId);
    if (!leaseId) {
      return yield* Effect.fail(leaseNotFound(dispatchId, "dispatchId"));
    }
    const entry = data.entries.get(leaseId);
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

type RoundTripAttachOutcome = "Attached" | "Cancel" | "Settled";

function attachRoundTripFiberToLease(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  fiber: Fiber.RuntimeFiber<unknown, unknown>,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const outcome = yield* Ref.modify(
      state.dataRef,
      (data): readonly [RoundTripAttachOutcome, LeaseRegistryData] => {
        const entry = data.entries.get(leaseId);
        if (!entry || entry.record.state === "ABANDONED") {
          return ["Cancel", data];
        }
        if (entry.record.state !== "PENDING") {
          // The child can resolve before its parent attaches the handle. It must
          // be allowed to finish post-commit work (presence, TTL, notification).
          return ["Settled", data];
        }
        if (entry.roundTripFiber !== null) {
          return [entry.roundTripFiber === fiber ? "Attached" : "Cancel", data];
        }
        return [
          "Attached",
          withLeaseEntry(data, leaseId, { ...entry, roundTripFiber: fiber }),
        ];
      },
    );
    if (outcome === "Cancel") yield* Fiber.interruptFork(fiber);
  });
}

type DisconnectTransition =
  | {
      readonly _tag: "Abandoned";
      readonly leaseId: LeaseId;
      readonly record: LeaseRecord;
      readonly roundTripFiber: Fiber.RuntimeFiber<unknown, unknown> | null;
    }
  | {
      readonly _tag: "Expired";
      readonly leaseId: LeaseId;
      readonly record: LeaseRecord;
      readonly expiredAt: string;
      readonly ttlFiber: Fiber.RuntimeFiber<unknown, unknown> | null;
      readonly wasActive: boolean;
    };

function makeDisconnectTransition(
  connId: ConnectionId,
  leaseId: LeaseId,
  entry: LeaseEntry,
  transitionedAt: string,
): DisconnectTransition | null {
  if (entry.record.binding.recipientConnectionId !== connId) return null;
  if (entry.record.state === "PENDING") {
    return {
      _tag: "Abandoned",
      leaseId,
      record: {
        ...entry.record,
        state: "ABANDONED",
        resolvedAt: transitionedAt,
      },
      roundTripFiber: entry.roundTripFiber,
    };
  }
  if (!isDisconnectExpirableState(entry.record.state)) return null;
  return {
    _tag: "Expired",
    leaseId,
    record: { ...entry.record, state: "EXPIRED", expiredAt: transitionedAt },
    expiredAt: transitionedAt,
    ttlFiber: entry.ttlFiber,
    wasActive: entry.record.state === "GRANTED",
  };
}

function commitDisconnectTransitions(
  state: LeaseRegistryState,
  connId: ConnectionId,
): Effect.Effect<ReadonlyArray<DisconnectTransition>, never, never> {
  const transitionedAt = new Date().toISOString();
  return Ref.modify(state.dataRef, (data) => {
    const entries = new Map(data.entries);
    const actions: Array<DisconnectTransition> = [];
    for (const [leaseId, entry] of data.entries) {
      const action = makeDisconnectTransition(
        connId,
        leaseId,
        entry,
        transitionedAt,
      );
      if (action !== null) {
        actions.push(action);
        entries.set(leaseId, {
          record: action.record,
          ttlFiber: null,
          roundTripFiber: null,
        });
      }
    }
    return [actions, actions.length === 0 ? data : { ...data, entries }];
  });
}

function observeDisconnectTransitions(
  state: LeaseRegistryState,
  transitions: ReadonlyArray<DisconnectTransition>,
): Effect.Effect<void, never, never> {
  return Effect.forEach(
    transitions,
    (transition) =>
      transition._tag === "Expired" && transition.wasActive
        ? observeLeaseActiveEnd(state, transition.leaseId, transition.record)
        : Effect.void,
    { concurrency: 1, discard: true },
  );
}

function runDisconnectTransition(
  state: LeaseRegistryState,
  transition: DisconnectTransition,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    if (transition._tag === "Abandoned") {
      if (transition.roundTripFiber) {
        yield* Fiber.interruptFork(transition.roundTripFiber);
      }
      yield* scheduleRetention(
        state,
        transition.leaseId,
        transition.record.dispatchId,
      );
      return;
    }

    if (transition.ttlFiber) yield* Fiber.interruptFork(transition.ttlFiber);
    yield* emitDispatchLeaseExpired(
      state,
      transition.record,
      transition.expiredAt,
    );
    yield* scheduleRetention(
      state,
      transition.leaseId,
      transition.record.dispatchId,
    );
  });
}

function abandonConnectionLeases(
  state: LeaseRegistryState,
  connId: ConnectionId,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const transitions = yield* state.transitionPermit.withPermits(1)(
      Effect.gen(function* () {
        const committed = yield* commitDisconnectTransitions(state, connId);
        yield* observeDisconnectTransitions(state, committed);
        return committed;
      }),
    );
    yield* Effect.forEach(
      transitions,
      (transition) => runDisconnectTransition(state, transition),
      { concurrency: 1, discard: true },
    );
  }).pipe(Effect.asVoid);
}

/**
 * Drain the registry at app shutdown (see {@link LeaseRegistry.shutdown}).
 *
 * The closed flag, entries, and dispatch index change in one atomic update.
 * Any concurrent registry transition therefore linearizes entirely before or
 * after shutdown; no writer can repopulate a partially drained registry.
 * `Fiber.interruptFork` is fire-and-forget, so shutdown never blocks on an
 * interrupt completing.
 */
function shutdownRegistry(
  state: LeaseRegistryState,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const entries = yield* state.transitionPermit.withPermits(1)(
      Effect.gen(function* () {
        const drained = yield* Ref.modify(state.dataRef, (data) => [
          data.entries,
          {
            entries: new Map(),
            dispatchIndex: new Map(),
            closed: true,
          },
        ]);
        yield* Deferred.succeed(state.shutdownSignal, void 0);
        return drained;
      }),
    );
    for (const entry of entries.values()) {
      if (entry.ttlFiber) yield* Fiber.interruptFork(entry.ttlFiber);
      if (entry.roundTripFiber)
        yield* Fiber.interruptFork(entry.roundTripFiber);
    }
  }).pipe(Effect.uninterruptible, Effect.withSpan("leaseRegistry.shutdown"));
}

function makeLeaseRegistryFromState(state: LeaseRegistryState): LeaseRegistry {
  return {
    mint: (ctx) => mintLease(state, ctx),
    resolve: (leaseId, verdict) => resolveLease(state, leaseId, verdict),
    claim: (leaseId) => claimLease(state, leaseId),
    read: (id) => readLease(state, id),
    abandon: (connId) => abandonConnectionLeases(state, connId),
    attachRoundTripFiber: (leaseId, fiber) =>
      attachRoundTripFiberToLease(state, leaseId, fiber),
    shutdown: () => shutdownRegistry(state),
  };
}

/**
 * Construct the registry. The constructor is the only public factory
 * — `LeaseRegistry` is referenced as an interface from call sites.
 *
 * Implementation: one `Ref&lt;LeaseRegistryData>` atomically owns entries,
 * dispatch index, and closed state. A narrow semaphore orders each state
 * commit with its presence observer callback; network notifications and fiber
 * interruption run after that critical section. A shared shutdown signal
 * cancels parked notification and retention effects.
 */
export function makeLeaseRegistry(
  deps: LeaseRegistryDeps,
): Effect.Effect<LeaseRegistry, never, never> {
  return Effect.gen(function* () {
    const dataRef = yield* Ref.make<LeaseRegistryData>({
      entries: new Map(),
      dispatchIndex: new Map(),
      closed: false,
    });
    const shutdownSignal = yield* Deferred.make<void>();
    const transitionPermit = yield* Effect.makeSemaphore(1);
    return makeLeaseRegistryFromState({
      deps,
      dataRef,
      shutdownSignal,
      transitionPermit,
    });
  }).pipe(Effect.withSpan("makeLeaseRegistry"));
}
