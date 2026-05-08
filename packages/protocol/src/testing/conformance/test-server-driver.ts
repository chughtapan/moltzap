/**
 * Cross-impl `dispatch-admission` test driver — architect interface stub
 * for the row 13 reshape cutover (#533).
 *
 * The 15 `dispatch-admission` properties registered in `dispatch-admission.ts`
 * cannot execute today because the round-trip needs TWO TestClients
 * scripted in lockstep against the same real server: a recipient that
 * issues `dispatch/request`, and a moderator that handles
 * `dispatch/authorize`. The properties also need to drive PENDING-state
 * disconnects, post-grant TTL elapse, scope-mismatched `dispatches/get`,
 * and same-conversation concurrency. None of those are reachable from a
 * single TestClient holding a single agent identity.
 *
 * This driver is the conformance-tier helper that fills the gap. It
 * does NOT subclass / wrap `TestServer` — TestServer is the byte-level
 * harness for fault-injection and stays untouched. The driver composes
 * existing `TestClient` primitives (`sendRpc`, `handleServerRpc`,
 * `awaitServerRequest`, `waitForNotification`, scope-controlled close)
 * against an injected `RealServerHandle` (already present on every
 * conformance run via `runner.ts:35`).
 *
 * Implementation lands in PR #533. Architect ships only the typed
 * contract; impl-staff fills the bodies. See architect-comment-#533 §3
 * for the rules each method enforces; §7 for the property-by-property
 * mapping; §9 risk #4 for the ack/release race the driver exposes.
 *
 * Principle 3 — every method's error channel is named (`PropertyFailure`
 * for property-level outcomes; tagged transport errors otherwise).
 * Principle 4 — verdict shape and lease state are closed string-literal
 * unions; the driver re-exports the wire types so property authors
 * never re-construct them by hand.
 */
import { Effect, type Scope } from "effect";
import type { ConformanceRunContext } from "./runner.js";
import type { PropertyFailure } from "./registry.js";
import type { AgentId } from "../../identity/agents.js";
import type { ConversationId, MessageId } from "../../task/conversations.js";
import type { TaskId } from "../../task/tasks.js";
import type { DispatchId, LeaseId } from "../../app/methods.js";
import type { DecodedNotification } from "../../transport/rpc-groups.js";
import type {
  DispatchRelease,
  DispatchesConsumed,
  DispatchesExpired,
} from "../../app/index.js";

// ── Verdict + state aliases (cross-impl driver re-exports) ────────────

/**
 * Closed verdict union mirroring the wire `DispatchAdmissionDecisionSchema`.
 * Properties that need to script a moderator's reply pass a
 * `DispatchVerdict` value to `recipient.expectAuthorize` /
 * `respondWith`; the driver encodes it to the wire shape internally.
 */
export type DispatchVerdict =
  | { readonly _tag: "grant"; readonly leaseTimeoutMs?: number }
  | { readonly _tag: "deny"; readonly reason?: string }
  | { readonly _tag: "hold"; readonly reason?: string };

/**
 * Closed lease-state union mirroring `LeaseStateSchema`. The driver's
 * `assertLeaseState` polls `dispatches/get` until the registry settles
 * to the named state or the bound elapses (impl-staff picks the bound
 * per-property; default 5 s).
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

// ── Recipient handle ──────────────────────────────────────────────────

/**
 * Recipient-side surface. Owns one TestClient connected to the real
 * server under a recipient agent identity. All methods return Effects
 * scoped to the surrounding `Scope`; releasing the scope closes the
 * underlying TestClient.
 */
export interface RecipientHandle {
  readonly agentId: AgentId;
  readonly connectionId: string;

  /**
   * Issue `dispatch/request` for the given inbound. Returns the ack
   * payload `{leaseId, dispatchId}`. Single recipient may issue many
   * concurrent requests; the property is responsible for ordering its
   * own assertions.
   */
  readonly requestDispatch: (params: {
    readonly conversationId: ConversationId;
    readonly messageId: MessageId;
    readonly senderAgentId: AgentId;
    readonly attempt?: number;
  }) => Effect.Effect<
    { readonly leaseId: LeaseId; readonly dispatchId: DispatchId },
    PropertyFailure
  >;

  /**
   * Park until a `dispatch/release` notification arrives that matches
   * `predicate` (default: any). Used by every property in the
   * `DispatchRelease` group + every property that asserts a verdict
   * delivery.
   */
  readonly waitForRelease: (
    predicate?: (frame: DecodedNotification<typeof DispatchRelease>) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<
    DecodedNotification<typeof DispatchRelease>,
    PropertyFailure
  >;

  /**
   * Send `messages/send` carrying `dispatchLeaseId`. Used to consume a
   * GRANTED lease + assert the consumed/duplicate behavior.
   */
  readonly sendWithLease: (params: {
    readonly conversationId: ConversationId;
    readonly leaseId: LeaseId;
    readonly text: string;
  }) => Effect.Effect<{ readonly messageId: MessageId }, PropertyFailure>;

  /**
   * Disconnect the recipient's WS without graceful shutdown.
   * Drives ABANDONED + EXPIRED-on-disconnect transitions for every
   * `*-disconnect-*` property. The returned Effect resolves once the
   * server has observed the close (registry's connection-close
   * finalizer fired).
   */
  readonly hardClose: Effect.Effect<void, PropertyFailure>;
}

// ── Moderator handle ──────────────────────────────────────────────────

/**
 * Moderator-side surface. Owns one TestClient connected to the real
 * server under a moderator agent identity, with `apps/register` already
 * driven to install a `dispatch_authorize` hook for the test app. Holds
 * the registered `appId` for `dispatches/get` scope assertions.
 */
export interface ModeratorHandle {
  readonly agentId: AgentId;
  readonly connectionId: string;
  readonly appId: string;

  /**
   * Park until a `dispatch/authorize` S→C request arrives that matches
   * `predicate` (default: any), then reply with `respondWith`. Internally
   * uses `TestClient.handleServerRpc` to register the reply and
   * `awaitServerRequest` to observe the params.
   *
   * `holdResponseFor` is for the timeout-synthesizes-deny property:
   * delaying the reply past the moderator-response TTL forces the server
   * into the synthesized-deny branch. Default: reply immediately.
   */
  readonly handleAuthorize: (opts: {
    readonly respondWith: DispatchVerdict;
    readonly predicate?: (params: {
      readonly taskId: TaskId;
      readonly conversationId: ConversationId;
      readonly messageId: MessageId;
    }) => boolean;
    readonly holdResponseFor?: number;
  }) => Effect.Effect<void, PropertyFailure>;

  /**
   * Drop the next inbound `dispatch/authorize` S→C request — install no
   * handler. Forces moderator-response TTL elapse. Used by
   * `dispatch-authorize-timeout-synthesizes-deny`.
   */
  readonly silenceAuthorize: Effect.Effect<void, PropertyFailure>;

  /**
   * Park until a `dispatches/consumed` or `dispatches/expired`
   * notification arrives matching `kind` and (optionally) `dispatchId`.
   */
  readonly waitForObservability: <K extends "consumed" | "expired">(
    kind: K,
    opts: {
      readonly dispatchId?: DispatchId;
      readonly timeoutMs?: number;
    },
  ) => Effect.Effect<
    K extends "consumed"
      ? DecodedNotification<typeof DispatchesConsumed>
      : DecodedNotification<typeof DispatchesExpired>,
    PropertyFailure
  >;

  /**
   * Issue `dispatches/get` from the moderator's connection. Used by the
   * positive `dispatches-get-moderator-sees-record` property + every
   * `assertLeaseState` poll.
   */
  readonly getLease: (dispatchId: DispatchId) => Effect.Effect<
    {
      readonly state: LeaseState;
      readonly verdict: DispatchVerdict | null;
      readonly leaseId: LeaseId;
    },
    PropertyFailure
  >;
}

// ── Top-level driver surface ──────────────────────────────────────────

/**
 * Cross-impl driver. One `DispatchTestDriver` instance per property,
 * acquired under the property's `Scope`. Wires up the real server,
 * recipient + moderator clients, and shared task / conversation
 * fixtures.
 */
export interface DispatchTestDriver {
  readonly recipient: RecipientHandle;
  readonly moderator: ModeratorHandle;
  readonly fixtures: {
    readonly taskId: TaskId;
    readonly conversationId: ConversationId;
  };

  /**
   * Spin up an additional recipient client under a fresh agent identity.
   * Used by `same-conversation-dispatches-reach-moderator-concurrently`
   * (two recipients in the same conversation issue `dispatch/request`
   * back-to-back).
   */
  readonly addRecipient: (opts: {
    readonly agentName?: string;
  }) => Effect.Effect<RecipientHandle, PropertyFailure, Scope.Scope>;

  /**
   * Issue `dispatches/get` from a NON-moderator connection (the
   * recipient or a third-party client). Used by the negative scope
   * property `dispatches-get-non-moderator-rejected`. Returns the
   * server's typed error rather than the lease record.
   */
  readonly getLeaseFromNonModerator: (
    dispatchId: DispatchId,
  ) => Effect.Effect<{ readonly errorCode: number }, PropertyFailure>;

  /**
   * Poll `dispatches/get` until the lease reaches `expected` or the
   * bound elapses. Returns the final record. Used by every property
   * that asserts a state transition (PENDING→GRANTED, GRANTED→EXPIRED,
   * CLAIMED→CONSUMED, etc.). Implementation polls every 25 ms; bound
   * defaults to 5 s.
   */
  readonly assertLeaseState: (
    dispatchId: DispatchId,
    expected: LeaseState,
    opts?: { readonly timeoutMs?: number },
  ) => Effect.Effect<void, PropertyFailure>;

  /**
   * Advance the test clock by `durationMs`. If the conformance harness
   * is running against `TestClock`, this fast-forwards TTLs; otherwise
   * (real-time mode) it is a `Effect.sleep`. Property authors call this
   * for `dispatches-expired-fires-on-ttl` and the moderator-response
   * timeout property.
   */
  readonly advanceTime: (durationMs: number) => Effect.Effect<void>;
}

// ── Constructor ──────────────────────────────────────────────────────

/**
 * Driver options. `taskAppId` controls whether the server-side path is
 * app-bound (moderated, default) or default-grant. Default: app-bound
 * via `taskAppId: "conformance-test-app"`. The `default-grant` properties
 * (none today; reserved for future) pass `taskAppId: null`.
 *
 * `moderatorTimeoutMs` is propagated to the manifest's
 * `hooks.dispatch_authorize.timeout_ms`. Properties that exercise the
 * moderator-response TTL pass a small value (e.g., 200 ms); properties
 * that don't care pass the default 5_000 ms.
 */
export interface DispatchTestDriverConfig {
  readonly taskAppId?: string | null;
  readonly moderatorTimeoutMs?: number;
  readonly leaseTimeoutMs?: number;
  /**
   * Conversation participants beyond the moderator + first recipient.
   * Used by `addRecipient` to pre-allocate so the second recipient can
   * join without `conversations/addParticipant` round-trips.
   */
  readonly extraRecipientCount?: number;
}

/**
 * Acquire a fully-wired driver under the surrounding `Scope`. Releases
 * close every TestClient + drop the `apps/register` registration.
 *
 * Property authors call this from inside their property body; the driver
 * is per-property, never shared. Cross-property state leakage is the
 * exact failure mode the per-property scope prevents.
 */
// SAFER-IMPL-STAFF: cross-impl driver wiring lands in PR #533 cutover.
// Body is the constructor that builds two TestClients (recipient + moderator)
// against `ctx.realServer.wsUrl`, drives `apps/register` for the moderator,
// creates a fixture task + conversation, and returns the assembled handle.
export function makeDispatchTestDriver(
  ctx: ConformanceRunContext,
  config?: DispatchTestDriverConfig,
): Effect.Effect<DispatchTestDriver, PropertyFailure, Scope.Scope> {
  void ctx;
  void config;
  return Effect.dieMessage(
    "makeDispatchTestDriver: not implemented — architect stub for #533 cutover",
  ) as Effect.Effect<DispatchTestDriver, PropertyFailure, Scope.Scope>;
}

// ── Re-export wire types for property authors ─────────────────────────

export type {
  DispatchRelease,
  DispatchesConsumed,
  DispatchesExpired,
} from "../../app/index.js";
