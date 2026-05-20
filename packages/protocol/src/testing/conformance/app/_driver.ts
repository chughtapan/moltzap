/**
 * Cross-impl `dispatch-admission` test driver — implementation for the
 * row 13 reshape cutover (#533).
 *
 * The 15 `dispatch-admission` properties registered in `dispatch-admission.ts`
 * cannot execute against a single TestClient: the round-trip needs TWO
 * TestClients scripted in lockstep against the same real server — a
 * recipient that issues `dispatch/request`, and a moderator that
 * receives `dispatch/authorize` and replies. The driver is the
 * conformance-tier helper that wires both ends.
 *
 * It does NOT subclass / wrap `TestServer` — TestServer is the byte-level
 * harness for fault-injection and stays untouched. The driver composes
 * existing `TestClient` primitives (`sendRpc`, `onAppCallback`,
 * `awaitServerRequest`, `waitForNotification`, scope-controlled close)
 * against an injected `RealServerHandle` (already present on every
 * conformance run via `runner.ts:35`).
 *
 * Architect plan #533 §3 + §7 + Revisions r1 (correction 2 dropped
 * `connectionId` from both handles).
 *
 * Principle 3 — every method's error channel is named
 * (`PropertyFailure` for property-level outcomes; tagged transport
 * errors otherwise).
 * Principle 4 — verdict shape and lease state are closed string-literal
 * unions; the driver re-exports the wire types so property authors
 * never re-construct them by hand.
 */
import {
  Cause,
  Chunk,
  Duration,
  Effect,
  Exit,
  Queue,
  Scope,
  Stream,
} from "effect";
import { RpcResponseError } from "../_shared/errors.js";
import type { Static } from "@sinclair/typebox";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  PropertyInvariantViolation,
  type PropertyFailure,
} from "../_shared/registry.js";
import type { AgentId } from "../../../identity/agents.js";
import {
  type ConversationId,
  type MessageId,
  TasksCreate,
  TasksCreateConversation,
  ConversationsAddParticipant,
  MessagesSend,
} from "@moltzap/protocol/task";
import type { TaskId } from "../../../task/tasks.js";
import {
  DispatchAuthorize,
  DispatchRelease,
  DispatchRequest,
  DispatchesConsumed,
  DispatchesExpired,
  DispatchesGet,
  type DispatchId,
  type LeaseId,
} from "../../../app/index.js";
import type { DecodedNotification } from "../../../transport/rpc-groups.js";
import { registerTestAgent, type TestAgent } from "../_shared/test-fixtures.js";
import {
  makeCloseableTestClient,
  makeTestClient,
  type CloseableTestClient,
  type ServerRpcParams,
  type ServerRpcResult,
  type TestClient,
} from "../_shared/driver/test-client.js";
import {
  makeTestAppManifest,
  registerTestApp,
  type TestApp,
} from "../_shared/test-app.js";

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
  readonly agentId: Static<typeof AgentId>;

  /**
   * Issue `dispatch/request` for the given inbound. Returns the ack
   * payload `{leaseId, dispatchId}`. Single recipient may issue many
   * concurrent requests; the property is responsible for ordering its
   * own assertions.
   */
  readonly requestDispatch: (params: {
    readonly conversationId: Static<typeof ConversationId>;
    readonly messageId: Static<typeof MessageId>;
    readonly senderAgentId: Static<typeof AgentId>;
    readonly attempt?: number;
  }) => Effect.Effect<
    {
      readonly leaseId: Static<typeof LeaseId>;
      readonly dispatchId: Static<typeof DispatchId>;
    },
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
   * GRANTED lease + assert the consumed/duplicate behavior. Returns the
   * minted message id on success; on the lease-already-CONSUMED path,
   * fails with a `PropertyInvariantViolation` whose `reason` carries
   * the wire-error code + `LeaseInvalid` data tag the server returned.
   */
  readonly sendWithLease: (params: {
    readonly conversationId: Static<typeof ConversationId>;
    readonly leaseId: Static<typeof LeaseId>;
    readonly text: string;
  }) => Effect.Effect<
    {
      readonly messageId: Static<typeof MessageId>;
      readonly errorCode?: number;
      readonly errorState?: string;
    },
    PropertyFailure
  >;

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
  readonly agentId: Static<typeof AgentId>;
  readonly appId: string;

  /**
   * Park until a `dispatch/authorize` S→C request arrives that matches
   * `predicate` (default: any), then reply with `respondWith`. Internally
   * uses `TestClient.onAppCallback` to register the reply and
   * `awaitServerRequest` to observe the params.
   *
   * `holdResponseFor` is for the timeout-synthesizes-deny property:
   * delaying the reply past the moderator-response TTL forces the server
   * into the synthesized-deny branch. Default: reply immediately.
   */
  readonly handleAuthorize: (opts: {
    readonly respondWith: DispatchVerdict;
    readonly predicate?: (params: {
      readonly taskId: Static<typeof TaskId>;
      readonly conversationId: Static<typeof ConversationId>;
      readonly messageId: Static<typeof MessageId>;
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
      readonly dispatchId?: Static<typeof DispatchId>;
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
  readonly getLease: (dispatchId: Static<typeof DispatchId>) => Effect.Effect<
    {
      readonly state: LeaseState;
      readonly verdict: DispatchVerdict | null;
      readonly leaseId: Static<typeof LeaseId>;
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
    readonly taskId: Static<typeof TaskId>;
    readonly conversationId: Static<typeof ConversationId>;
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
    dispatchId: Static<typeof DispatchId>,
  ) => Effect.Effect<{ readonly errorCode: number }, PropertyFailure>;

  /**
   * Poll `dispatches/get` until the lease reaches `expected` or the
   * bound elapses. Returns the final record. Used by every property
   * that asserts a state transition (PENDING→GRANTED, GRANTED→EXPIRED,
   * CLAIMED→CONSUMED, etc.). Implementation polls every 25 ms; bound
   * defaults to 5 s.
   */
  readonly assertLeaseState: (
    dispatchId: Static<typeof DispatchId>,
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
}

const CATEGORY = "dispatch-admission" as const;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CAPTURE_CAPACITY = 256;
const DEFAULT_ASSERT_LEASE_STATE_BOUND_MS = 5_000;
const ASSERT_LEASE_STATE_POLL_MS = 25;
const DEFAULT_MODERATOR_TIMEOUT_MS = 5_000;
const DEFAULT_WAIT_FOR_RELEASE_MS = 5_000;
const DEFAULT_OBSERVABILITY_TIMEOUT_MS = 5_000;
// Property name for `PropertyInvariantViolation` emitted from setup
// failures (HTTP register, WS connect, fixtures bootstrap). Treated as
// a single category so consumers can grep one tag.
const SETUP_FAILURE_PROPERTY = "driver-acquire";
// Truncation bound for unwrapped Effect cause messages embedded in
// violation reasons. Long enough to identify the failure mode; short
// enough to avoid swamping property reports.
const ERROR_CAUSE_TRUNCATE_LEN = 200;
// `Math.random().toString(36)` returns "0." + base-36 digits; slicing
// at index 2 drops the "0." prefix. The 6-char suffix is enough
// to disambiguate per-property instances within a single conformance
// run.
const RANDOM_SUFFIX_LEN = 6;

function violation(name: string, reason: string): PropertyInvariantViolation {
  return new PropertyInvariantViolation({ category: CATEGORY, name, reason });
}

function unwrapError<E>(err: E): string {
  if (err === null || err === undefined) return "<no error>";
  if (typeof err === "string") return err;
  const anyErr = err as { _tag?: string; message?: string };
  return `${anyErr._tag ?? "<unknown>"}: ${anyErr.message ?? String(err)}`;
}

/**
 * Pull the first typed `RpcResponseError` out of an `Exit`'s `Cause`.
 * The TestClient's `sendRpc` channel is `RpcResponseError | …`; this
 * helper isolates the typed error so callers don't have to parse
 * `String(cause)`.
 */
function firstRpcResponseError<A>(
  exit: Exit.Exit<A, unknown>,
): RpcResponseError | null {
  if (Exit.isSuccess(exit)) return null;
  const failures = Cause.failures(exit.cause);
  for (const failure of Chunk.toReadonlyArray(failures)) {
    if (failure instanceof RpcResponseError) return failure;
  }
  return null;
}

function verdictToWire(
  verdict: DispatchVerdict,
): ServerRpcResult<typeof DispatchAuthorize> {
  switch (verdict._tag) {
    case "grant":
      return verdict.leaseTimeoutMs !== undefined
        ? {
            admission: {
              decision: "grant",
              leaseTimeoutMs: verdict.leaseTimeoutMs,
            },
          }
        : { admission: { decision: "grant" } };
    case "deny":
      return verdict.reason !== undefined
        ? { admission: { decision: "deny", reason: verdict.reason } }
        : { admission: { decision: "deny" } };
    case "hold":
      return verdict.reason !== undefined
        ? { admission: { decision: "hold", reason: verdict.reason } }
        : { admission: { decision: "hold" } };
  }
}

function verdictFromWire(raw: unknown): DispatchVerdict | null {
  const verdict = wireVerdictView(raw);
  if (verdict === null) return null;
  switch (verdict.decision) {
    case "grant":
      return grantVerdictFromWire(verdict);
    case "deny":
      return reasonVerdictFromWire("deny", verdict.reason);
    case "hold":
      return reasonVerdictFromWire("hold", verdict.reason);
    default:
      return null;
  }
}

function wireVerdictView(raw: unknown): WireVerdictView | null {
  return raw !== null && typeof raw === "object"
    ? (raw as WireVerdictView)
    : null;
}

function grantVerdictFromWire(verdict: WireVerdictView): DispatchVerdict {
  return typeof verdict.leaseTimeoutMs === "number"
    ? { _tag: "grant", leaseTimeoutMs: verdict.leaseTimeoutMs }
    : { _tag: "grant" };
}

function reasonVerdictFromWire(
  tag: "deny" | "hold",
  reason: unknown,
): DispatchVerdict {
  return typeof reason === "string" ? { _tag: tag, reason } : { _tag: tag };
}

type DispatchIdParamsView = { readonly dispatchId?: Static<typeof DispatchId> };
type WireVerdictView = {
  readonly decision?: unknown;
  readonly reason?: unknown;
  readonly leaseTimeoutMs?: unknown;
};
type ObservabilityNotification<K extends "consumed" | "expired"> =
  K extends "consumed"
    ? DecodedNotification<typeof DispatchesConsumed>
    : DecodedNotification<typeof DispatchesExpired>;

interface AcquiredCloseableClient {
  readonly agent: TestAgent;
  readonly client: CloseableTestClient;
}

function acquireAgent(
  ctx: ConformanceRunContext,
  name: string,
): Effect.Effect<TestAgent, PropertyInvariantViolation> {
  return registerTestAgent({ baseUrl: ctx.realServer.baseUrl, name }).pipe(
    Effect.mapError((e) =>
      violation(
        SETUP_FAILURE_PROPERTY,
        `registerTestAgent(${name}) failed: status=${String(e.status)} body=${e.body}`,
      ),
    ),
  );
}

function acquireSharedClient(
  ctx: ConformanceRunContext,
  agent: TestAgent,
): Effect.Effect<TestClient, PropertyInvariantViolation, Scope.Scope> {
  return makeTestClient({
    serverUrl: ctx.realServer.wsUrl,
    agentKey: agent.apiKey,
    agentId: agent.agentId,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    captureCapacity: DEFAULT_CAPTURE_CAPACITY,
  }).pipe(
    Effect.mapError((e) =>
      violation(
        SETUP_FAILURE_PROPERTY,
        `makeTestClient(${agent.name}) failed: ${unwrapError(e)}`,
      ),
    ),
  );
}

function acquireCloseableClient(
  ctx: ConformanceRunContext,
  agent: TestAgent,
): Effect.Effect<
  AcquiredCloseableClient,
  PropertyInvariantViolation,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const client = yield* makeCloseableTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: agent.apiKey,
      agentId: agent.agentId,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
      captureCapacity: DEFAULT_CAPTURE_CAPACITY,
    }).pipe(
      Effect.mapError((e) =>
        violation(
          SETUP_FAILURE_PROPERTY,
          `makeCloseableTestClient(${agent.name}) failed: ${unwrapError(e)}`,
        ),
      ),
    );
    // Tie the underlying scope to the surrounding scope so cleanup
    // happens automatically on property-scope close (and an explicit
    // earlier `close` is still fine — it's idempotent).
    yield* Effect.addFinalizer(() => client.close);
    return { agent, client };
  });
}

/**
 * #645: Spec B's `Stream.async` surface only emits frames that arrive
 * AFTER materialisation. Conformance properties rely on a polling-shape
 * "subscribe AFTER trigger" pattern; bridge by installing a long-lived
 * pump at handle-construction time that buffers each per-definition
 * frame into an unbounded Queue. `waitFor*` consumes from the Queue,
 * which preserves historical buffering semantics without leaking back
 * into the deleted polling shape.
 */
// #ignore-sloppy-code[async-keyword]: JSDoc reference to `Stream.async` Effect primitive, not a JS `async` modifier
interface ReleaseBuffer {
  readonly queue: Queue.Queue<DecodedNotification<typeof DispatchRelease>>;
}

function buildRecipientHandle(
  acquired: AcquiredCloseableClient,
): Effect.Effect<RecipientHandle, never, Scope.Scope> {
  return Effect.gen(function* () {
    const queue =
      yield* Queue.unbounded<DecodedNotification<typeof DispatchRelease>>();
    yield* Effect.forkScoped(
      acquired.client.subscribe(DispatchRelease).pipe(
        Stream.runForEach((frame) => Queue.offer(queue, frame)),
        Effect.catchAll(() => Effect.void),
      ),
    );
    const buffer: ReleaseBuffer = { queue };
    return {
      agentId: acquired.agent.agentId,
      requestDispatch: (params) => requestDispatch(acquired, params),
      waitForRelease: (predicate, timeoutMs) =>
        waitForRelease(buffer, predicate, timeoutMs),
      sendWithLease: (params) => sendWithLease(acquired, params),
      hardClose: acquired.client.close,
    } satisfies RecipientHandle;
  });
}

function requestDispatch(
  acquired: AcquiredCloseableClient,
  params: Parameters<RecipientHandle["requestDispatch"]>[0],
): ReturnType<RecipientHandle["requestDispatch"]> {
  return acquired.client
    .sendRpc(DispatchRequest, {
      conversationId: params.conversationId,
      messageId: params.messageId,
      senderAgentId: params.senderAgentId,
      parts: [{ type: "text", text: "conformance-dispatch-probe" }],
      ...(params.attempt !== undefined ? { attempt: params.attempt } : {}),
    })
    .pipe(
      Effect.mapError((e) =>
        violation(
          "recipient.requestDispatch",
          `dispatch/request failed: ${unwrapError(e)}`,
        ),
      ),
    );
}

function waitForRelease(
  buffer: ReleaseBuffer,
  // eslint-disable-next-line agent-code-guard/no-conditional-chaining -- optional predicate is a value-level passthrough to `takeMatchingFromQueue`'s match loop; not a refinement-of-discriminant decision
  predicate?: Parameters<RecipientHandle["waitForRelease"]>[0],
  timeoutMs = DEFAULT_WAIT_FOR_RELEASE_MS,
): ReturnType<RecipientHandle["waitForRelease"]> {
  // #645: pull from the per-handle Queue populated by the long-lived
  // `subscribe(DispatchRelease)` pump installed in `buildRecipientHandle`.
  // The pump preserves historical buffering semantics that the legacy
  // polling shape provided implicitly; properties continue to call
  // `waitForRelease` AFTER the triggering RPC without races.
  return takeMatchingFromQueue(buffer.queue, predicate, timeoutMs).pipe(
    Effect.mapError((reason) =>
      reason === "timeout"
        ? releaseWaitTimeoutFailure(timeoutMs)
        : violation(
            "recipient.waitForRelease",
            `dispatch/release wait failed: ${reason}`,
          ),
    ),
  );
}

/**
 * Helper: pull frames off a Queue until `predicate` matches, or fail
 * with `"timeout"` after `timeoutMs`. Used by both `waitForRelease`
 * and `waitForObservability` to share the polling-style match loop.
 */
function takeMatchingFromQueue<A>(
  queue: Queue.Queue<A>,
  predicate: ((frame: A) => boolean) | undefined,
  timeoutMs: number,
): Effect.Effect<A, "timeout"> {
  const deadline = Date.now() + timeoutMs;
  const loop: Effect.Effect<A, "timeout"> = Effect.gen(function* () {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return yield* Effect.fail("timeout" as const);
    const frame = yield* Queue.take(queue).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(remaining),
        onTimeout: () => "timeout" as const,
      }),
    );
    if (predicate === undefined || predicate(frame)) return frame;
    return yield* loop;
  });
  return loop;
}

function releaseWaitTimeoutFailure(timeoutMs: number): PropertyFailure {
  return violation("recipient.waitForRelease", `timeout after ${timeoutMs}ms`);
}

function sendWithLease(
  acquired: AcquiredCloseableClient,
  params: Parameters<RecipientHandle["sendWithLease"]>[0],
): ReturnType<RecipientHandle["sendWithLease"]> {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(
      acquired.client.sendRpc(MessagesSend, {
        conversationId: params.conversationId,
        parts: [{ type: "text", text: params.text }],
        dispatchLeaseId: params.leaseId,
      }),
    );
    return Exit.isSuccess(exit)
      ? messageSendSuccess(exit.value)
      : yield* messageSendFailure(exit);
  });
}

function messageSendSuccess(result: unknown): {
  readonly messageId: Static<typeof MessageId>;
} {
  return {
    messageId: (result as { message: { id: Static<typeof MessageId> } }).message
      .id,
  };
}

function messageSendFailure(exit: Exit.Exit<unknown, unknown>): Effect.Effect<
  {
    readonly messageId: Static<typeof MessageId>;
    readonly errorCode: number;
    readonly errorState?: string;
  },
  PropertyFailure
> {
  const rpcErr = firstRpcResponseError(exit);
  if (rpcErr === null) {
    return Effect.fail(
      violation(
        "recipient.sendWithLease",
        `messages/send failed without RpcResponseError: ${exitCauseSummary(exit)}`,
      ),
    );
  }
  const errorState = rpcErrorState(rpcErr);
  return Effect.succeed({
    messageId: "" as Static<typeof MessageId>,
    errorCode: rpcErr.code,
    ...(errorState !== undefined ? { errorState } : {}),
  });
}

function rpcErrorState(error: RpcResponseError): string | undefined {
  const data = error.data;
  if (data === null || typeof data !== "object") return undefined;
  const state = (data as { readonly state?: unknown }).state;
  return typeof state === "string" ? state : undefined;
}

type DispatchAuthorizePredicateInput = {
  readonly taskId: Static<typeof TaskId>;
  readonly conversationId: Static<typeof ConversationId>;
  readonly messageId: Static<typeof MessageId>;
};

interface ModeratorHandleOptions {
  readonly agent: TestAgent;
  readonly client: TestClient;
  readonly appId: string;
  readonly app: TestApp | null;
}

interface ResolvedDriverConfig {
  readonly moderatorTimeoutMs: number;
  readonly appId: string | null;
}

interface DriverAgents {
  readonly moderatorAgent: TestAgent;
  readonly recipientAgent: TestAgent;
}

interface DriverClients {
  readonly moderatorClient: TestClient;
  readonly recipientAcquired: AcquiredCloseableClient;
}

interface DriverFixtures {
  readonly taskId: Static<typeof TaskId>;
  readonly conversationId: Static<typeof ConversationId>;
}

interface DriverBuildParts {
  readonly ctx: ConformanceRunContext;
  readonly clients: DriverClients;
  readonly fixtures: DriverFixtures;
  readonly recipient: RecipientHandle;
  readonly moderator: ModeratorHandle;
}

interface AddRecipientInput {
  readonly ctx: ConformanceRunContext;
  readonly moderatorClient: TestClient;
  readonly conversationId: Static<typeof ConversationId>;
  readonly opts: Parameters<DispatchTestDriver["addRecipient"]>[0];
}

interface LeaseStateTimeoutInput {
  readonly dispatchId: Static<typeof DispatchId>;
  readonly expected: LeaseState;
  readonly bound: number;
  readonly last: LeaseState | null;
  readonly lastError: string | null;
}

/**
 * Per-`ModeratorHandle` Queue buffers for the two observability
 * notification kinds (#645). Long-lived pumps subscribe to each
 * definition at handle-construction time and offer arrivals; the
 * `waitForObservability` API consumes the matching queue.
 */
interface ObservabilityBuffers {
  readonly consumed: Queue.Queue<
    DecodedNotification<typeof DispatchesConsumed>
  >;
  readonly expired: Queue.Queue<DecodedNotification<typeof DispatchesExpired>>;
}

function buildModeratorHandle(
  opts: ModeratorHandleOptions,
): Effect.Effect<ModeratorHandle, never, Scope.Scope> {
  return Effect.gen(function* () {
    const consumed =
      yield* Queue.unbounded<DecodedNotification<typeof DispatchesConsumed>>();
    const expired =
      yield* Queue.unbounded<DecodedNotification<typeof DispatchesExpired>>();
    yield* Effect.forkScoped(
      opts.client.subscribe(DispatchesConsumed).pipe(
        Stream.runForEach((frame) => Queue.offer(consumed, frame)),
        Effect.catchAll(() => Effect.void),
      ),
    );
    yield* Effect.forkScoped(
      opts.client.subscribe(DispatchesExpired).pipe(
        Stream.runForEach((frame) => Queue.offer(expired, frame)),
        Effect.catchAll(() => Effect.void),
      ),
    );
    const buffers: ObservabilityBuffers = { consumed, expired };
    return {
      agentId: opts.agent.agentId,
      appId: opts.appId,
      handleAuthorize: (cfg) => handleAuthorize(opts.app, cfg),
      silenceAuthorize: silenceAuthorize(opts.app),
      waitForObservability: (kind, waitOpts) =>
        waitForObservability(buffers, kind, waitOpts),
      getLease: (dispatchId) => getLease(opts.client, dispatchId),
    } satisfies ModeratorHandle;
  });
}

function handleAuthorize(
  app: TestApp | null,
  cfg: Parameters<ModeratorHandle["handleAuthorize"]>[0],
): Effect.Effect<void, PropertyFailure> {
  return app === null
    ? missingModeratorApp("handleAuthorize")
    : app.dispatchAuthorize.handle({
        respondWith: verdictToWire(cfg.respondWith),
        ...(cfg.predicate === undefined
          ? {}
          : {
              predicate: (params) =>
                cfg.predicate?.(authorizePredicateInput(params)) ?? false,
            }),
        ...(cfg.holdResponseFor === undefined
          ? {}
          : { holdResponseFor: cfg.holdResponseFor }),
      });
}

function silenceAuthorize(
  app: TestApp | null,
): Effect.Effect<void, PropertyFailure> {
  return app === null
    ? missingModeratorApp("silenceAuthorize")
    : app.dispatchAuthorize.silence;
}

function missingModeratorApp(
  method: "handleAuthorize" | "silenceAuthorize",
): Effect.Effect<never, PropertyFailure> {
  return Effect.fail(
    violation(
      `moderator.${method}`,
      "driver was configured without an app-bound dispatch_authorize hook",
    ),
  );
}

function authorizePredicateInput(
  params: ServerRpcParams<typeof DispatchAuthorize>,
): DispatchAuthorizePredicateInput {
  return {
    taskId: params.taskId,
    conversationId: params.conversationId,
    messageId: params.message.id,
  };
}

function waitForObservability<K extends "consumed" | "expired">(
  buffers: ObservabilityBuffers,
  kind: K,
  opts: Parameters<ModeratorHandle["waitForObservability"]>[1],
): Effect.Effect<ObservabilityNotification<K>, PropertyFailure> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_OBSERVABILITY_TIMEOUT_MS;
  // #645: pull from the per-handle Queue populated by the long-lived
  // `subscribe(DispatchesConsumed|Expired)` pumps installed in
  // `buildModeratorHandle`. The pump preserves historical-buffer
  // semantics so properties can call `waitForObservability` after the
  // triggering action (e.g. `advanceTime`) without races.
  const queue =
    kind === "consumed"
      ? (buffers.consumed as Queue.Queue<ObservabilityFrame>)
      : (buffers.expired as Queue.Queue<ObservabilityFrame>);
  return takeMatchingFromQueue(
    queue,
    (frame) => matchesDispatchId(frame.params, opts.dispatchId),
    timeoutMs,
  ).pipe(
    Effect.map((frame) => frame as ObservabilityNotification<K>),
    Effect.mapError((reason) =>
      reason === "timeout"
        ? observabilityTimeoutFailure(kind, timeoutMs)
        : observabilityViolation(kind, `notification wait failed: ${reason}`),
    ),
  );
}

function observabilityTimeoutFailure(
  kind: "consumed" | "expired",
  timeoutMs: number,
): PropertyFailure {
  return violation(
    `moderator.waitForObservability(${kind})`,
    `timeout after ${timeoutMs}ms`,
  );
}

type ObservabilityFrame =
  | DecodedNotification<typeof DispatchesConsumed>
  | DecodedNotification<typeof DispatchesExpired>;

function observabilityViolation(
  kind: "consumed" | "expired",
  reason: string,
): PropertyFailure {
  return violation(`moderator.waitForObservability(${kind})`, reason);
}

function matchesDispatchId(
  params: unknown,
  dispatchId: Static<typeof DispatchId> | undefined,
): boolean {
  if (dispatchId === undefined) return true;
  return (params as DispatchIdParamsView).dispatchId === dispatchId;
}

function getLease(
  client: TestClient,
  dispatchId: Static<typeof DispatchId>,
): ReturnType<ModeratorHandle["getLease"]> {
  return client.sendRpc(DispatchesGet, { dispatchId }).pipe(
    Effect.map(leaseResultFromWire),
    Effect.mapError((e) =>
      violation(
        "moderator.getLease",
        `dispatches/get failed: ${unwrapError(e)}`,
      ),
    ),
  );
}

function leaseResultFromWire(result: unknown): {
  readonly state: LeaseState;
  readonly verdict: DispatchVerdict | null;
  readonly leaseId: Static<typeof LeaseId>;
} {
  const lease = (result as { lease: Record<string, unknown> }).lease;
  return {
    state: lease["state"] as LeaseState,
    verdict: verdictFromWire(lease["verdict"]),
    leaseId: lease["leaseId"] as Static<typeof LeaseId>,
  };
}

/**
 * Acquire a fully-wired driver under the surrounding `Scope`. Releases
 * close every TestClient + drop the `apps/register` registration.
 *
 * Property authors call this from inside their property body; the driver
 * is per-property, never shared. Cross-property state leakage is the
 * exact failure mode the per-property scope prevents.
 */
export function makeDispatchTestDriver(
  ctx: ConformanceRunContext,
  config?: DispatchTestDriverConfig,
): Effect.Effect<DispatchTestDriver, PropertyFailure, Scope.Scope> {
  const resolved = resolveDriverConfig(config ?? {});
  return Effect.gen(function* () {
    const agents = yield* acquireDriverAgents(ctx);
    const clients = yield* acquireDriverClients(ctx, agents);
    const app = yield* registerDriverApp(clients.moderatorClient, resolved);
    const fixtures = yield* createDriverFixtures(
      clients.moderatorClient,
      resolved.appId,
      agents.recipientAgent,
    );
    const recipient = yield* buildRecipientHandle(clients.recipientAcquired);
    const moderator = yield* buildModeratorHandle({
      agent: agents.moderatorAgent,
      client: clients.moderatorClient,
      appId: resolved.appId ?? "",
      app,
    });
    return buildDispatchDriver({
      ctx,
      clients,
      fixtures,
      recipient,
      moderator,
    });
  }).pipe(Effect.withSpan("makeDispatchTestDriver"));
}

function resolveDriverConfig(
  config: DispatchTestDriverConfig,
): ResolvedDriverConfig {
  const taskAppId = config?.taskAppId;
  return {
    moderatorTimeoutMs:
      config?.moderatorTimeoutMs ?? DEFAULT_MODERATOR_TIMEOUT_MS,
    appId:
      taskAppId === null
        ? null
        : (taskAppId ?? `conformance-dispatch-app-${cryptoRandomShort()}`),
  };
}

function acquireDriverAgents(
  ctx: ConformanceRunContext,
): Effect.Effect<DriverAgents, PropertyFailure> {
  return Effect.gen(function* () {
    return {
      moderatorAgent: yield* acquireAgent(ctx, "conf-mod"),
      recipientAgent: yield* acquireAgent(ctx, "conf-rcpt"),
    };
  });
}

function acquireDriverClients(
  ctx: ConformanceRunContext,
  agents: DriverAgents,
): Effect.Effect<DriverClients, PropertyFailure, Scope.Scope> {
  return Effect.gen(function* () {
    return {
      moderatorClient: yield* acquireSharedClient(ctx, agents.moderatorAgent),
      recipientAcquired: yield* acquireCloseableClient(
        ctx,
        agents.recipientAgent,
      ),
    };
  });
}

function registerDriverApp(
  moderatorClient: TestClient,
  config: ResolvedDriverConfig,
): Effect.Effect<TestApp | null, PropertyFailure> {
  if (config.appId === null) return Effect.succeed(null);
  return registerTestApp({
    client: moderatorClient,
    manifest: makeTestAppManifest({
      appId: config.appId,
      name: "Conformance Dispatch Test App",
      dispatchAuthorizeTimeoutMs: config.moderatorTimeoutMs,
    }),
  }).pipe(
    Effect.mapError((e) =>
      violation(SETUP_FAILURE_PROPERTY, `apps/register failed: ${e.message}`),
    ),
  );
}

function createDriverFixtures(
  moderatorClient: TestClient,
  appId: string | null,
  recipientAgent: TestAgent,
): Effect.Effect<DriverFixtures, PropertyFailure> {
  return Effect.gen(function* () {
    const taskId = yield* createDriverTask(moderatorClient, appId);
    const conversationId = yield* createDriverConversation(
      moderatorClient,
      taskId,
      recipientAgent,
    );
    return { taskId, conversationId };
  });
}

function createDriverTask(
  moderatorClient: TestClient,
  appId: string | null,
): Effect.Effect<Static<typeof TaskId>, PropertyFailure> {
  const taskParams =
    appId !== null
      ? { appId, tmType: "self" as const }
      : { tmType: "self" as const };
  return moderatorClient.sendRpc(TasksCreate, taskParams).pipe(
    Effect.map(
      (result) => (result as { task: { id: Static<typeof TaskId> } }).task.id,
    ),
    Effect.mapError((e) =>
      violation(
        SETUP_FAILURE_PROPERTY,
        `tasks/create failed: ${unwrapError(e)}`,
      ),
    ),
  );
}

function createDriverConversation(
  moderatorClient: TestClient,
  taskId: Static<typeof TaskId>,
  recipientAgent: TestAgent,
): Effect.Effect<Static<typeof ConversationId>, PropertyFailure> {
  return moderatorClient
    .sendRpc(TasksCreateConversation, {
      taskId,
      type: "group",
      name: "conformance-dispatch-conv",
      participants: [{ type: "agent" as const, id: recipientAgent.agentId }],
    })
    .pipe(
      Effect.map(
        (result) =>
          (
            result as {
              conversation: { id: Static<typeof ConversationId> };
            }
          ).conversation.id,
      ),
      Effect.mapError((e) =>
        violation(
          SETUP_FAILURE_PROPERTY,
          `tasks/createConversation failed: ${unwrapError(e)}`,
        ),
      ),
    );
}

function buildDispatchDriver(parts: DriverBuildParts): DispatchTestDriver {
  return {
    recipient: parts.recipient,
    moderator: parts.moderator,
    fixtures: parts.fixtures,
    addRecipient: (opts) =>
      addRecipient({
        ctx: parts.ctx,
        moderatorClient: parts.clients.moderatorClient,
        conversationId: parts.fixtures.conversationId,
        opts,
      }),
    getLeaseFromNonModerator: (dispatchId) =>
      getLeaseFromNonModerator(
        parts.clients.recipientAcquired.client,
        dispatchId,
      ),
    assertLeaseState: (dispatchId, expected, opts) =>
      assertLeaseState(parts.moderator, dispatchId, expected, opts),
    advanceTime,
  };
}

function addRecipient(
  input: AddRecipientInput,
): ReturnType<DispatchTestDriver["addRecipient"]> {
  return Effect.gen(function* () {
    const name = input.opts.agentName ?? "conf-rcpt2";
    const agent = yield* acquireAgent(input.ctx, name);
    const acquired = yield* acquireCloseableClient(input.ctx, agent);
    yield* addConversationParticipant(
      input.moderatorClient,
      input.conversationId,
      agent,
    );
    return yield* buildRecipientHandle(acquired);
  });
}

function addConversationParticipant(
  moderatorClient: TestClient,
  conversationId: Static<typeof ConversationId>,
  agent: TestAgent,
): Effect.Effect<void, PropertyFailure> {
  return moderatorClient
    .sendRpc(ConversationsAddParticipant, {
      conversationId,
      participant: { type: "agent" as const, id: agent.agentId },
    })
    .pipe(
      Effect.mapError((e) =>
        violation(
          "driver.addRecipient",
          `conversations/addParticipant failed: ${unwrapError(e)}`,
        ),
      ),
    );
}

function getLeaseFromNonModerator(
  client: CloseableTestClient,
  dispatchId: Static<typeof DispatchId>,
): ReturnType<DispatchTestDriver["getLeaseFromNonModerator"]> {
  return Effect.gen(function* () {
    const exit = yield* Effect.exit(
      client.sendRpc(DispatchesGet, { dispatchId }),
    );
    if (Exit.isSuccess(exit)) {
      return yield* Effect.fail(
        violation(
          "driver.getLeaseFromNonModerator",
          "dispatches/get unexpectedly succeeded for non-moderator caller",
        ),
      );
    }
    const rpcErr = firstRpcResponseError(exit);
    if (rpcErr === null) return yield* nonModeratorLeaseMissingRpcError(exit);
    return { errorCode: rpcErr.code };
  });
}

function nonModeratorLeaseMissingRpcError(
  exit: Exit.Exit<unknown, unknown>,
): Effect.Effect<never, PropertyFailure> {
  return Effect.fail(
    violation(
      "driver.getLeaseFromNonModerator",
      `dispatches/get failed without RpcResponseError: ${exitCauseSummary(exit)}`,
    ),
  );
}

function exitCauseSummary(exit: Exit.Exit<unknown, unknown>): string {
  return Exit.isFailure(exit)
    ? String(exit.cause).slice(0, ERROR_CAUSE_TRUNCATE_LEN)
    : "<success>";
}

function assertLeaseState(
  moderator: ModeratorHandle,
  dispatchId: Static<typeof DispatchId>,
  expected: LeaseState,
  opts?: Parameters<DispatchTestDriver["assertLeaseState"]>[2],
): ReturnType<DispatchTestDriver["assertLeaseState"]> {
  return Effect.gen(function* () {
    const bound = opts?.timeoutMs ?? DEFAULT_ASSERT_LEASE_STATE_BOUND_MS;
    const deadline = Date.now() + bound;
    let last: LeaseState | null = null;
    let lastError: string | null = null;
    while (Date.now() < deadline) {
      const exit = yield* Effect.exit(moderator.getLease(dispatchId));
      if (Exit.isSuccess(exit)) {
        last = exit.value.state;
        if (last === expected) return;
      } else {
        lastError = String(exit.cause).slice(0, ERROR_CAUSE_TRUNCATE_LEN);
      }
      yield* Effect.sleep(Duration.millis(ASSERT_LEASE_STATE_POLL_MS));
    }
    return yield* leaseStateTimeout({
      dispatchId,
      expected,
      bound,
      last,
      lastError,
    });
  });
}

function leaseStateTimeout(
  input: LeaseStateTimeoutInput,
): Effect.Effect<never, PropertyFailure> {
  return Effect.fail(
    violation(
      "driver.assertLeaseState",
      `lease ${input.dispatchId} did not reach ${input.expected} within ${input.bound}ms (last=${input.last ?? "<unread>"}, lastError=${input.lastError ?? "<none>"})`,
    ),
  );
}

function advanceTime(durationMs: number): Effect.Effect<void> {
  return Effect.sleep(Duration.millis(durationMs));
}

// ── Crypto helper for unique appId (avoids `crypto` import noise) ─────
function cryptoRandomShort(): string {
  return globalThis.crypto
    .randomUUID()
    .replaceAll("-", "")
    .slice(0, RANDOM_SUFFIX_LEN);
}

// ── Re-export wire types for property authors ─────────────────────────

export type {
  DispatchRelease,
  DispatchesConsumed,
  DispatchesExpired,
} from "../../../app/index.js";
