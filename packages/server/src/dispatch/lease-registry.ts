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
import {
  DEFAULT_DISPATCH_LEASE_TIMEOUT_MS,
  type dispatchLeaseGet,
  type DispatchId,
  dispatchId as DispatchIdSchema,
  leaseId as LeaseIdSchema,
  dispatchRelease,
  dispatchLeaseConsumed,
  dispatchLeaseExpired,
  type LeaseId,
} from "@moltzap/protocol/message/dispatch";
import type { ResultOf, NotificationParamsOf } from "@moltzap/protocol/rpc";
import type { AnyNotificationDefinition } from "@moltzap/protocol/socket/catalog";
import type { ConnectionManager } from "#socket";

/** Wire-side LeaseRecord shape (flat). */
type LeaseRecordWire = ResultOf<typeof dispatchLeaseGet>["lease"];
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
 * - A ConversationId has at most one PENDING, GRANTED, or CLAIMED lease.
 *   Minting against an existing reservation returns `conversation_busy`
 *   without creating a lease. HOLD retains its record but releases the
 *   reservation because a held dispatch retries through a fresh request.
 *
 * ─── State machine ──────────────────────────────────────────────────.
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
 * Every GRANTED lease owns a TTL. A verdict-provided `leaseTimeoutMs` wins;
 * an omitted timeout uses the production default shared with the client.
 * HOLD remains until recipient disconnect or registry shutdown. CLAIMED and
 * terminal states skip TTL.
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
 * accidentally confuse them with `MessageId` / generic strings.
 */
interface LeaseMintResult {
  readonly leaseId: LeaseId;
  readonly dispatchId: DispatchId;
}

interface ConversationBusyResult {
  readonly outcome: "conversation_busy";
}

type LeaseMintOutcome = LeaseMintResult | ConversationBusyResult;

/**
 * Tagged error channel for the registry's transition-rejecting paths.
 * The `state` carries the lease's CURRENT state (so callers can
 * surface a precise wire-error code, e.g. Typed-CONSUMED /
 * typed-EXPIRED) and `expected` carries the set of states the
 * operation would have accepted.
 */
export class LeaseInvalidError extends Data.TaggedError("LeaseInvalidError")<{
  readonly leaseId: LeaseId;
  readonly state: LeaseState;
  readonly expected: readonly LeaseState[];
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
  ) => Effect.Effect<void, LeaseInvalidError>;

  /**
   * CLAIMED → GRANTED. Used by the `Effect.acquireUseRelease` release path
   * when `sendInsert` fails after `claim` succeeded but before `finalize`.
   */
  readonly rollback: Effect.Effect<void, LeaseInvalidError>;
}

/**
 * Public contract of the lease registry. One instance per server lifetime,
 * shared by dispatch admission and message send. Backed by an in-process
 * `Ref&lt;LeaseRegistryData>` containing entries, dispatch index, conversation
 * reservations, and the closed flag — no DB row. State transitions are atomic
 * via `Ref.modify`.
 *
 * Lease state machine (eight states; `LeaseState` in this file is the
 * normative enumeration):.
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
 *   participant Recv as Recipient client
 *   participant DA as DispatchAdmissionService
 *   participant LR as LeaseRegistry
 *   participant Mod as Moderator
 *   participant MS as MessageService
 *
 *   Recv->>DA: agent/dispatch/request (C→S)
 *   DA->>LR: mint(binding) — PENDING
 *   alt conversation already reserved
 *     LR-->>DA: {outcome: conversation_busy}
 *     DA-->>Recv: busy returned without a lease
 *   else conversation available
 *     LR-->>DA: {leaseId, dispatchId}
 *     DA-->>Recv: ack returned immediately
 *     DA->>Mod: Effect.forkDaemon — app/dispatch/authorize
 *     Mod-->>DA: verdict
 *     DA->>LR: resolve(leaseId, verdict) — GRANTED | DENIED | HOLD
 *     LR->>Recv: agent/dispatch/released {verdict}
 *     Recv->>MS: agent/message/send with dispatchLeaseId
 *     MS->>LR: claim(leaseId) — GRANTED → CLAIMED
 *     Note over MS: Effect.acquireUseRelease owns the claim
 *     MS->>MS: sendInsert
 *     alt insert succeeds
 *       MS->>LR: finalize(messageId), CLAIMED to CONSUMED
 *     else insert fails
 *       MS->>LR: rollback, CLAIMED to GRANTED
 *     end
 *   end
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
 * Each GRANTED lease owns one daemon TTL fiber. The fiber is bound to the
 * immutable record version that created it, so a stale pre-rollback timer
 * cannot expire a newer GRANTED epoch. An explicit verdict timeout overrides
 * the shared production default.
 */
export interface LeaseRegistry {
  /**
   * Atomically reserve the binding's ConversationId and mint a new PENDING
   * lease. If the conversation is already reserved, returns
   * `conversation_busy` without creating lease or dispatch records.
   * Synchronous (`Effect&lt;..., never>`) — the registry is in-process. Records
   * the moderator-bound binding for audit, `app/dispatch/lease/get`, and
   * connection-close cleanup.
   *
   * Both ids are minted via `crypto.randomUUID()`; the brand on
   * `LeaseId` / `DispatchId` keeps them disjoint at every call site.
   */
  mint(binding: ModeratorBoundLeaseBinding): Effect.Effect<LeaseMintOutcome>;

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
  ): Effect.Effect<void, LeaseInvalidError | LeaseNotFoundError>;

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
  ): Effect.Effect<Claim, LeaseInvalidError | LeaseNotFoundError>;

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
  ): Effect.Effect<LeaseRecord, LeaseNotFoundError>;

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
  abandon(connId: ConnectionId): Effect.Effect<void>;

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
  ): Effect.Effect<void>;

  /**
   * Deterministic shutdown drain — invoked by `CoreApp.close`
   * (`core/app.ts -> closeCoreAppEffect`) BEFORE `Scope.close(appScope)`.
   *
   * Atomically closes and drains the registry, completes the shared signal
   * observed by background notification and retention fibers, then interrupts
   * live TTL and moderator round-trip fibers. No concurrent transition can
   * repopulate the registry after the drain.
   *
   * Idempotent; safe to call when no leases are live. Error channel `never` —
   * shutdown is best-effort.
   */
  shutdown(): Effect.Effect<void>;
}

/**
 * Constructor dependencies for the lease registry.
 * - `connections`: looked up by the internal `emitDispatchRelease`
 *   helper to find the recipient and at `app/dispatch/lease-consumed` /
 *   `app/dispatch/lease-expired` emission to find the moderator's connection.
 * - `leaseRetentionMs`: terminal-state retention window (CONSUMED /
 *   DENIED / EXPIRED / ABANDONED). GRANTED leases use an explicit verdict
 *   timeout or the shared production default.
 */
interface LeaseRegistryDeps {
  readonly connections: ConnectionManager;
  readonly leaseRetentionMs: number;
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
  readonly conversationReservations: ReadonlyMap<ConversationId, LeaseId>;

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
  readonly shutdownSignal: Deferred.Deferred<undefined>;
}

function leaseHoldsConversationReservation(state: LeaseState): boolean {
  return state === "PENDING" || state === "GRANTED" || state === "CLAIMED";
}

function withLeaseEntry(
  data: LeaseRegistryData,
  leaseId: LeaseId,
  entry: LeaseEntry,
): LeaseRegistryData {
  const entries = new Map(data.entries);
  const conversationReservations = new Map(data.conversationReservations);
  const conversationId = entry.record.binding.conversationId;
  entries.set(leaseId, entry);
  if (leaseHoldsConversationReservation(entry.record.state)) {
    conversationReservations.set(conversationId, leaseId);
  } else if (conversationReservations.get(conversationId) === leaseId) {
    conversationReservations.delete(conversationId);
  }
  return { ...data, entries, conversationReservations };
}

function modifyRegistry<A, E>(
  state: LeaseRegistryState,
  transition: (
    data: LeaseRegistryData,
  ) => readonly [Either.Either<A, E>, LeaseRegistryData],
): Effect.Effect<A, E> {
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
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

function leaseTimeoutForVerdict(verdict: LeaseVerdict): number | null {
  if (verdict._tag !== "grant") {
    return null;
  }
  return verdict.leaseTimeoutMs ?? DEFAULT_DISPATCH_LEASE_TIMEOUT_MS;
}

function leaseVerdictWithEffectiveTimeout(verdict: LeaseVerdict): LeaseVerdict {
  if (verdict._tag !== "grant" || verdict.leaseTimeoutMs !== undefined) {
    return verdict;
  }
  return {
    _tag: "grant",
    leaseTimeoutMs: DEFAULT_DISPATCH_LEASE_TIMEOUT_MS,
  };
}

/**
 * Translation point between the in-process nested `LeaseRecord` and the wire
 * `LeaseRecordSchema` shape.
 * @param record Value supplied to the operation.
 * @returns The lease record to wire result.
 */
export function leaseRecordToWire(record: LeaseRecord): LeaseRecordWire {
  return {
    dispatchId: record.dispatchId,
    leaseId: record.leaseId,
    conversationId: record.binding.conversationId,
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

/**
 * Map the in-process verdict to the wire admission decision shape.
 * @param v Value supplied to the operation.
 * @returns The lease verdict to wire result.
 */
function leaseVerdictToWire(
  v: LeaseVerdict | null,
):
  | { decision: "grant"; leaseTimeoutMs?: number }
  | { decision: "deny"; reason?: string }
  | { decision: "hold"; reason?: string }
  | null {
  if (v === null) {
    return null;
  }
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
      const absurd: never = v;
      return absurd;
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
  expected: readonly LeaseState[],
  operation: LeaseInvalidError["operation"],
): LeaseInvalidError {
  return new LeaseInvalidError({ leaseId, state, expected, operation });
}

function fireNotification<D extends AnyNotificationDefinition>(
  state: LeaseRegistryState,
  connId: ConnectionId,
  definition: D,
  params: NotificationParamsOf<D>,
): Effect.Effect<void> {
  // Once the registry is shutting down, every connection is being torn down
  // concurrently. Drop the notification deterministically — no consumer
  // remains at shutdown.
  return Ref.get(state.dataRef).pipe(
    Effect.flatMap((data) => {
      if (data.closed) {
        return Effect.void;
      }
      return Effect.forkDaemon(
        Effect.raceFirst(
          Effect.disconnect(
            fireNotificationToConnection(state, connId, definition, params),
          ),
          Deferred.await(state.shutdownSignal),
        ).pipe(Effect.interruptible),
      ).pipe(Effect.asVoid);
    }),
  );
}

function fireNotificationToConnection<D extends AnyNotificationDefinition>(
  state: LeaseRegistryState,
  connId: ConnectionId,
  definition: D,
  params: NotificationParamsOf<D>,
): Effect.Effect<void> {
  return state.deps.connections.peek(connId).pipe(
    Effect.flatMap((connOpt) => {
      if (Option.isNone(connOpt)) {
        return Effect.logDebug(
          "lease-registry: target connection gone; dropping notification",
        ).pipe(Effect.annotateLogs({ connId }));
      }
      // The forked reverse-client effect settles on the client's ack; lease
      // transitions never wait for that acknowledgement.
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
): Effect.Effect<void> {
  const wire = leaseVerdictToWire(verdict);
  if (wire === null) {
    return Effect.void;
  }
  return fireNotification(
    state,
    record.binding.recipientConnectionId,
    dispatchRelease,
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
): Effect.Effect<void> {
  return fireNotification(
    state,
    record.binding.moderatorConnectionId,
    dispatchLeaseConsumed,
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
): Effect.Effect<void> {
  return fireNotification(
    state,
    record.binding.moderatorConnectionId,
    dispatchLeaseExpired,
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
): Effect.Effect<void> {
  return Ref.update(state.dataRef, (data) => {
    const entry = data.entries.get(leaseId);
    if (!entry || entry.record.dispatchId !== dispatchId) {
      return data;
    }
    const entries = new Map(data.entries);
    const dispatchIndex = new Map(data.dispatchIndex);
    const conversationReservations = new Map(data.conversationReservations);
    entries.delete(leaseId);
    dispatchIndex.delete(dispatchId);
    const conversationId = entry.record.binding.conversationId;
    if (conversationReservations.get(conversationId) === leaseId) {
      conversationReservations.delete(conversationId);
    }
    return { ...data, entries, dispatchIndex, conversationReservations };
  });
}

function scheduleRetention(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  dispatchId: DispatchId,
): Effect.Effect<void> {
  return Effect.forkDaemon(
    Effect.raceFirst(
      Effect.sleep(`${state.deps.leaseRetentionMs} millis`).pipe(
        Effect.flatMap(() => removeEntry(state, leaseId, dispatchId)),
      ),
      Deferred.await(state.shutdownSignal),
    ).pipe(Effect.interruptible),
  ).pipe(Effect.asVoid);
}

function isTtlExpirableState(state: LeaseState): boolean {
  return state === "GRANTED";
}

interface ExpiredLeaseTransition {
  readonly record: LeaseRecord;
  readonly expiredAt: string;
}

function commitTtlExpiry(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  expectedRecord: LeaseRecord,
): Effect.Effect<ExpiredLeaseTransition | null> {
  const expiredAt = new Date().toISOString();
  return Ref.modify(state.dataRef, (data) => {
    const entry = data.entries.get(leaseId);
    if (
      !entry ||
      entry.record !== expectedRecord ||
      !isTtlExpirableState(entry.record.state)
    ) {
      return [null, data];
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
    return [{ record, expiredAt }, withLeaseEntry(data, leaseId, nextEntry)];
  });
}

function expireLeaseFromTtl(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  expectedRecord: LeaseRecord,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const transition = yield* commitTtlExpiry(state, leaseId, expectedRecord);
    if (transition === null) {
      return;
    }
    yield* scheduleRetention(state, leaseId, transition.record.dispatchId);
    yield* emitDispatchLeaseExpired(
      state,
      transition.record,
      transition.expiredAt,
    );
  });
}

function scheduleTtlForEntry(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  entry: LeaseEntry,
): Effect.Effect<void> {
  const timeoutMs = entry.record.leaseTimeoutMs;
  if (timeoutMs === null || !isTtlExpirableState(entry.record.state)) {
    return Effect.void;
  }
  return Effect.gen(function* () {
    const fiber = yield* Effect.forkDaemon(
      Effect.sleep(`${timeoutMs} millis`).pipe(
        Effect.flatMap(() => expireLeaseFromTtl(state, leaseId, entry.record)),
        Effect.interruptible,
      ),
    );
    const attached = yield* Ref.modify(state.dataRef, (data) => {
      const current = data.entries.get(leaseId);
      if (
        !current ||
        current.record !== entry.record ||
        current.ttlFiber !== null
      ) {
        return [false, data];
      }
      return [
        true,
        withLeaseEntry(data, leaseId, { ...current, ttlFiber: fiber }),
      ];
    });
    if (!attached) {
      yield* Fiber.interruptFork(fiber);
    }
  });
}

function modifyClaimedEntry<A>(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  operation: "finalize" | "rollback",
  transition: (entry: LeaseEntry) => readonly [A, LeaseEntry],
): Effect.Effect<A, LeaseInvalidError> {
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
): Effect.Effect<void, LeaseInvalidError> {
  return Effect.gen(function* () {
    const consumedAt = new Date().toISOString();
    const consumedRecord = yield* modifyClaimedEntry(
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

    yield* scheduleRetention(state, leaseId, consumedRecord.dispatchId);
    yield* emitDispatchLeaseConsumed(
      state,
      consumedRecord,
      messageId,
      consumedAt,
    );
  });
}

function rollbackClaim(
  state: LeaseRegistryState,
  leaseId: LeaseId,
): Effect.Effect<void, LeaseInvalidError> {
  return Effect.gen(function* () {
    const grantedEntry = yield* modifyClaimedEntry(
      state,
      leaseId,
      "rollback",
      (entry) => {
        const nextEntry: LeaseEntry = {
          record: { ...entry.record, state: "GRANTED" },
          ttlFiber: null,
          roundTripFiber: null,
        };
        return [nextEntry, nextEntry];
      },
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
): Effect.Effect<LeaseMintOutcome> {
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
      if (data.closed) {
        return ["closed" as const, data];
      }
      if (data.conversationReservations.has(binding.conversationId)) {
        return ["conversation_busy" as const, data];
      }
      const dispatchIndex = new Map(data.dispatchIndex);
      dispatchIndex.set(dispatchId, leaseId);
      return [
        "inserted" as const,
        {
          ...withLeaseEntry(data, leaseId, entry),
          dispatchIndex,
        },
      ];
    });
    if (inserted === "closed") {
      return yield* Effect.interrupt;
    }
    if (inserted === "conversation_busy") {
      return { outcome: "conversation_busy" };
    }
    return { leaseId, dispatchId };
  });
}

function commitResolvedLease(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  verdict: LeaseVerdict,
): Effect.Effect<LeaseEntry, LeaseInvalidError | LeaseNotFoundError> {
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
): Effect.Effect<void, LeaseInvalidError | LeaseNotFoundError> {
  return Effect.gen(function* () {
    const effectiveVerdict = leaseVerdictWithEffectiveTimeout(verdict);
    const nextEntry = yield* commitResolvedLease(
      state,
      leaseId,
      effectiveVerdict,
    );
    yield* scheduleTtlForEntry(state, leaseId, nextEntry);
    if (nextEntry.record.state === "DENIED") {
      yield* scheduleRetention(state, leaseId, nextEntry.record.dispatchId);
    }
    yield* emitDispatchRelease(state, nextEntry.record, effectiveVerdict);
  });
}

function commitClaimedLease(
  state: LeaseRegistryState,
  leaseId: LeaseId,
): Effect.Effect<
  Fiber.RuntimeFiber<unknown, unknown> | null,
  LeaseInvalidError | LeaseNotFoundError
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
): Effect.Effect<Claim, LeaseInvalidError | LeaseNotFoundError> {
  return Effect.gen(function* () {
    const ttlFiber = yield* commitClaimedLease(state, leaseId);
    if (ttlFiber) {
      yield* Fiber.interruptFork(ttlFiber);
    }
    return makeClaim(state, leaseId);
  });
}

function readLease(
  state: LeaseRegistryState,
  id:
    | { readonly _tag: "leaseId"; readonly value: LeaseId }
    | { readonly _tag: "dispatchId"; readonly value: DispatchId },
): Effect.Effect<LeaseRecord, LeaseNotFoundError> {
  return Ref.get(state.dataRef).pipe(
    Effect.flatMap((data) => {
      const leaseId =
        id._tag === "leaseId" ? id.value : data.dispatchIndex.get(id.value);
      const entry =
        leaseId === undefined ? undefined : data.entries.get(leaseId);
      return entry
        ? Effect.succeed(entry.record)
        : Effect.fail(leaseNotFound(id.value, id._tag));
    }),
  );
}

function attachRoundTripFiberToLease(
  state: LeaseRegistryState,
  leaseId: LeaseId,
  fiber: Fiber.RuntimeFiber<unknown, unknown>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const shouldCancel = yield* Ref.modify(state.dataRef, (data) => {
      const entry = data.entries.get(leaseId);
      if (!entry || entry.record.state === "ABANDONED") {
        return [true, data];
      }
      if (entry.record.state !== "PENDING") {
        // The child can resolve before its parent attaches the handle. It must
        // be allowed to finish post-commit work (TTL, notification).
        return [false, data];
      }
      if (entry.roundTripFiber !== null) {
        return [entry.roundTripFiber !== fiber, data];
      }
      return [
        false,
        withLeaseEntry(data, leaseId, { ...entry, roundTripFiber: fiber }),
      ];
    });
    if (shouldCancel) {
      yield* Fiber.interruptFork(fiber);
    }
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
    };

function makeDisconnectTransition(
  connId: ConnectionId,
  leaseId: LeaseId,
  entry: LeaseEntry,
  transitionedAt: string,
): DisconnectTransition | null {
  if (entry.record.binding.recipientConnectionId !== connId) {
    return null;
  }
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
  if (entry.record.state !== "GRANTED" && entry.record.state !== "HOLD") {
    return null;
  }
  return {
    _tag: "Expired",
    leaseId,
    record: { ...entry.record, state: "EXPIRED", expiredAt: transitionedAt },
    expiredAt: transitionedAt,
    ttlFiber: entry.ttlFiber,
  };
}

function commitDisconnectTransitions(
  state: LeaseRegistryState,
  connId: ConnectionId,
): Effect.Effect<readonly DisconnectTransition[]> {
  const transitionedAt = new Date().toISOString();
  return Ref.modify(state.dataRef, (data) => {
    let nextData = data;
    const actions: DisconnectTransition[] = [];
    for (const [leaseId, entry] of data.entries) {
      const action = makeDisconnectTransition(
        connId,
        leaseId,
        entry,
        transitionedAt,
      );
      if (action !== null) {
        actions.push(action);
        nextData = withLeaseEntry(nextData, leaseId, {
          record: action.record,
          ttlFiber: null,
          roundTripFiber: null,
        });
      }
    }
    return [actions, nextData];
  });
}

function runDisconnectTransition(
  state: LeaseRegistryState,
  transition: DisconnectTransition,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (transition._tag === "Abandoned") {
      if (transition.roundTripFiber) {
        yield* Fiber.interruptFork(transition.roundTripFiber);
      }
    } else {
      if (transition.ttlFiber) {
        yield* Fiber.interruptFork(transition.ttlFiber);
      }
    }
    yield* scheduleRetention(
      state,
      transition.leaseId,
      transition.record.dispatchId,
    );
    if (transition._tag === "Expired") {
      yield* emitDispatchLeaseExpired(
        state,
        transition.record,
        transition.expiredAt,
      );
    }
  });
}

function abandonConnectionLeases(
  state: LeaseRegistryState,
  connId: ConnectionId,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const transitions = yield* commitDisconnectTransitions(state, connId);
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
 * @param state Value supplied to the operation.
 * @returns The shutdown registry result.
 */
function shutdownRegistry(state: LeaseRegistryState): Effect.Effect<void> {
  return Effect.gen(function* () {
    const entries = yield* Ref.modify(state.dataRef, (data) => [
      data.entries,
      {
        entries: new Map(),
        dispatchIndex: new Map(),
        conversationReservations: new Map(),
        closed: true,
      },
    ]);
    yield* Deferred.succeed(state.shutdownSignal, void 0);
    for (const entry of entries.values()) {
      if (entry.ttlFiber) {
        yield* Fiber.interruptFork(entry.ttlFiber);
      }
      if (entry.roundTripFiber) {
        yield* Fiber.interruptFork(entry.roundTripFiber);
      }
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
 * dispatch index, conversation reservations, and closed state; network
 * notifications and fiber interruption run after the commit. A shared shutdown
 * signal cancels parked notification and retention effects.
 * @param deps Value supplied to the operation.
 * @returns The created lease registry.
 */
export function makeLeaseRegistry(
  deps: LeaseRegistryDeps,
): Effect.Effect<LeaseRegistry> {
  return Effect.gen(function* () {
    const dataRef = yield* Ref.make<LeaseRegistryData>({
      entries: new Map(),
      dispatchIndex: new Map(),
      conversationReservations: new Map(),
      closed: false,
    });
    const shutdownSignal = yield* Deferred.make<undefined>();
    return makeLeaseRegistryFromState({
      deps,
      dataRef,
      shutdownSignal,
    });
  }).pipe(Effect.withSpan("makeLeaseRegistry"));
}
