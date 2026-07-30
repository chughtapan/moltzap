/**
 * Cross-impl `dispatch-admission` test driver.
 *
 * The 15 `dispatch-admission` properties cannot execute against a single
 * one client: the round-trip needs agent and app clients scripted in lockstep
 * against the same real server — a recipient that issues
 * `agent/dispatch/request`, and a moderator that receives `app/dispatch/authorize`
 * and replies. The driver is the conformance-tier helper that wires both
 * ends.
 *
 * It composes existing lifecycle-backed client primitives (`sendRpc`,
 * `onAppCallback`,
 * `awaitServerRequest`, `subscribe`, scope-controlled close) against an
 * injected `RealServerHandle` (already present on every conformance run
 * via the conformance `runner`).
 *
 * Every method's error channel is named (`PropertyFailure` for
 * property-level outcomes; tagged transport errors otherwise). Verdict
 * shape and lease state are closed string-literal unions; the driver
 * re-exports the wire types so property authors never re-construct them
 * by hand.
 */
import {
  Cause,
  Chunk,
  Duration,
  Effect,
  Exit,
  Queue,
  type Scope,
  Stream,
  Schema,
} from "effect";
import { RpcResponseError } from "../_shared/errors.js";
import type { ConformanceRunContext } from "../_shared/runner.js";
import {
  PropertyInvariantViolation,
  type PropertyFailure,
} from "../_shared/registry.js";
import type { agentId } from "#identity";
import {
  type appId as appIdSchema,
  taskRequest,
  taskUpdate,
} from "@moltzap/protocol/task";
import {
  conversationCreate,
  conversationUpdate,
  type conversationId as conversationIdSchema,
  type messageId,
} from "@moltzap/protocol/conversation";
import {
  leaseId,
  type dispatchAuthorize,
  dispatchRelease,
  dispatchRequest,
  dispatchLeaseConsumed,
  dispatchLeaseExpired,
  dispatchLeaseGet,
  type dispatchId as dispatchIdSchema,
} from "#message/dispatch";
import { messagesSend } from "@moltzap/protocol/message";
import type { taskId as taskIdSchema } from "#task";
import type { NotificationDelivery, ResultOf } from "#transport";
import { registerTestAgent, type TestAgent } from "../_shared/test-fixtures.js";
import {
  makeAgentTestClient,
  makeCloseableAgentTestClient,
  type AgentTestClient,
  type AppTestClient,
  type CloseableAgentTestClient,
  type ServerRpcParams,
  type ServerRpcResult,
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
 * `assertLeaseState` polls `app/dispatch/lease/get` until the registry settles
 * to the named state or the bound elapses (the bound is per-property;
 * default 5 s).
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
 * Recipient-side surface. Owns one `AgentTestClient` connected to the real
 * server under a recipient agent identity. All methods return Effects
 * scoped to the surrounding `Scope`; releasing the scope closes the
 * underlying agent client.
 */
export interface RecipientHandle {
  readonly agentId: Schema.Schema.Type<typeof agentId>;

  /**
   * Issue `agent/dispatch/request` for the given inbound. Returns the ack
   * payload `{leaseId, dispatchId}`. Single recipient may issue many
   * concurrent requests; the property is responsible for ordering its
   * own assertions.
   */
  readonly requestDispatch: (params: {
    readonly conversationId: Schema.Schema.Type<typeof conversationIdSchema>;
    readonly messageId: Schema.Schema.Type<typeof messageId>;
    readonly senderAgentId: Schema.Schema.Type<typeof agentId>;
    readonly attempt?: number;
  }) => Effect.Effect<
    {
      readonly leaseId: Schema.Schema.Type<typeof leaseId>;
      readonly dispatchId: Schema.Schema.Type<typeof dispatchIdSchema>;
    },
    PropertyFailure
  >;

  /**
   * Park until a `agent/dispatch/released` notification arrives that matches
   * `predicate` (default: any). Used by every property in the
   * `DispatchRelease` group + every property that asserts a verdict
   * delivery.
   */
  readonly waitForRelease: (
    predicate?: (
      frame: NotificationDelivery<typeof dispatchRelease>,
    ) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<
    NotificationDelivery<typeof dispatchRelease>,
    PropertyFailure
  >;

  /**
   * Send `agent/message/send` carrying `dispatchLeaseId`. Used to consume a
   * GRANTED lease + assert the consumed/duplicate behavior. Returns the
   * minted message id on success; on the lease-already-CONSUMED path,
   * fails with a `PropertyInvariantViolation` whose `reason` carries
   * the wire-error code + `LeaseInvalid` data tag the server returned.
   */
  readonly sendWithLease: (params: {
    readonly taskId: Schema.Schema.Type<typeof taskIdSchema>;
    readonly conversationId: Schema.Schema.Type<typeof conversationIdSchema>;
    readonly leaseId: Schema.Schema.Type<typeof leaseId>;
    readonly text: string;
  }) => Effect.Effect<SendWithLeaseResult, PropertyFailure>;

  /**
   * Disconnect the recipient's WS without graceful shutdown.
   * Drives ABANDONED + EXPIRED-on-disconnect transitions for every
   * `*-disconnect-*` property. The returned Effect resolves once the
   * server has observed the close (registry's connection-close
   * finalizer fired).
   */
  readonly hardClose: Effect.Effect<void, PropertyFailure>;
}

type SendWithLeaseResult =
  | {
      readonly messageId: Schema.Schema.Type<typeof messageId>;
      readonly errorTag?: never;
      readonly errorState?: never;
    }
  | {
      readonly messageId?: never;
      readonly errorTag: string;
      readonly errorState?: string;
    };

// ── Moderator handle ──────────────────────────────────────────────────

/**
 * Moderator-side surface. Owns one `AppTestClient` connected to the real
 * server under a moderator app identity, with HTTP registration plus
 * `app/network/connect` already driven to install a `dispatch_authorize` hook. Holds
 * the registered `appId` for `app/dispatch/lease/get` scope assertions.
 */
export interface ModeratorHandle {
  readonly agentId: Schema.Schema.Type<typeof agentId>;
  readonly appId: string;

  /**
   * Park until a `app/dispatch/authorize` S→C request arrives that matches
   * `predicate` (default: any), then reply with `respondWith`. Internally
   * uses `AppTestClient.onAppCallback` to register the reply and
   * `awaitServerRequest` to observe the params.
   *
   * `holdResponseFor` is for the timeout-synthesizes-deny property:
   * delaying the reply past the moderator-response TTL forces the server
   * into the synthesized-deny branch. Default: reply immediately.
   */
  readonly handleAuthorize: (opts: {
    readonly respondWith: DispatchVerdict;
    readonly predicate?: (params: {
      readonly taskId: Schema.Schema.Type<typeof taskIdSchema>;
      readonly conversationId: Schema.Schema.Type<typeof conversationIdSchema>;
      readonly messageId: Schema.Schema.Type<typeof messageId>;
    }) => boolean;
    readonly holdResponseFor?: number;
  }) => Effect.Effect<void, PropertyFailure>;

  /**
   * Drop the next inbound `app/dispatch/authorize` S→C request — install no
   * handler. Forces moderator-response TTL elapse. Used by
   * `dispatch-authorize-timeout-synthesizes-deny`.
   */
  readonly silenceAuthorize: Effect.Effect<void, PropertyFailure>;

  /**
   * Park until a `app/dispatch/lease-consumed` or `app/dispatch/lease-expired`
   * notification arrives matching `kind` and (optionally) `dispatchId`.
   */
  readonly waitForObservability: <K extends "consumed" | "expired">(
    kind: K,
    opts: {
      readonly dispatchId?: Schema.Schema.Type<typeof dispatchIdSchema>;
      readonly timeoutMs?: number;
    },
  ) => Effect.Effect<
    K extends "consumed"
      ? NotificationDelivery<typeof dispatchLeaseConsumed>
      : NotificationDelivery<typeof dispatchLeaseExpired>,
    PropertyFailure
  >;

  /**
   * Issue `app/dispatch/lease/get` from the moderator's connection. Used by the
   * positive `dispatch-lease-get-moderator-sees-record` property + every
   * `assertLeaseState` poll.
   */
  readonly getLease: (
    dispatchId: Schema.Schema.Type<typeof dispatchIdSchema>,
  ) => Effect.Effect<
    {
      readonly state: LeaseState;
      readonly verdict: DispatchVerdict | null;
      readonly leaseId: Schema.Schema.Type<typeof leaseId>;
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
    readonly taskId: Schema.Schema.Type<typeof taskIdSchema>;
    readonly conversationId: Schema.Schema.Type<typeof conversationIdSchema>;
  };

  /**
   * Spin up an additional recipient client under a fresh agent identity.
   * Used by `same-conversation-dispatch-requests-reach-moderator-concurrently`
   * (two recipients in the same conversation issue `agent/dispatch/request`
   * back-to-back).
   */
  readonly addRecipient: (opts: {
    readonly agentName?: string;
  }) => Effect.Effect<RecipientHandle, PropertyFailure, Scope.Scope>;

  /**
   * Poll `app/dispatch/lease/get` until the lease reaches `expected` or the
   * bound elapses. Returns the final record. Used by every property
   * that asserts a state transition (PENDING→GRANTED, GRANTED→EXPIRED,
   * CLAIMED→CONSUMED, etc.). Implementation polls every 25 ms; bound
   * defaults to 5 s.
   */
  readonly assertLeaseState: (
    dispatchId: Schema.Schema.Type<typeof dispatchIdSchema>,
    expected: LeaseState,
    opts?: { readonly timeoutMs?: number },
  ) => Effect.Effect<void, PropertyFailure>;

  /**
   * Sleep `durationMs` against the real clock to let server-side TTLs elapse.
   * Property authors call this for `dispatch-lease-expired-fires-on-ttl` and the
   * moderator-response timeout property, which both run against a live server.
   */
  readonly advanceTime: (durationMs: number) => Effect.Effect<void>;
}

// ── Constructor ──────────────────────────────────────────────────────

const CATEGORY = "dispatch-admission";
const DEFAULT_TIMEOUT_MS = 5_000;
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
function violation(name: string, reason: string): PropertyInvariantViolation {
  return new PropertyInvariantViolation({ category: CATEGORY, name, reason });
}

function unwrapError(err: unknown): string {
  if (err === null || err === undefined) {
    return "<no error>";
  }
  if (typeof err === "string") {
    return err;
  }
  if (typeof err !== "object") {
    return `non-object error (${typeof err})`;
  }
  const tag: unknown = Reflect.get(err, "_tag");
  const message: unknown = Reflect.get(err, "message");
  return `${typeof tag === "string" ? tag : "<unknown>"}: ${
    typeof message === "string" ? message : Object.prototype.toString.call(err)
  }`;
}

/**
 * Pull the first typed `RpcResponseError` out of an `Exit`'s `Cause`.
 * The conformance client's `sendRpc` channel is `RpcResponseError | ...`; this
 * helper isolates the typed error so callers don't have to parse
 * `String(cause)`.
 * @param exit Value supplied to the operation.
 * @returns The first rpc response error result.
 */
function firstRpcResponseError<A>(
  exit: Exit.Exit<A, unknown>,
): RpcResponseError | null {
  if (Exit.isSuccess(exit)) {
    return null;
  }
  const failures = Cause.failures(exit.cause);
  for (const failure of Chunk.toReadonlyArray(failures)) {
    if (failure instanceof RpcResponseError) {
      return failure;
    }
  }
  return null;
}

function verdictToWire(
  verdict: DispatchVerdict,
): ServerRpcResult<typeof dispatchAuthorize> {
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
    default:
      return verdict satisfies never;
  }
}

function verdictFromWire(raw: unknown): DispatchVerdict | null {
  const verdict = wireVerdictView(raw);
  if (verdict === null) {
    return null;
  }
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
  return raw !== null && typeof raw === "object" ? raw : null;
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

interface WireVerdictView {
  readonly decision?: unknown;
  readonly reason?: unknown;
  readonly leaseTimeoutMs?: unknown;
}
type ObservabilityNotification<K extends "consumed" | "expired"> =
  K extends "consumed"
    ? NotificationDelivery<typeof dispatchLeaseConsumed>
    : NotificationDelivery<typeof dispatchLeaseExpired>;

interface AcquiredCloseableClient {
  readonly agent: TestAgent;
  readonly client: CloseableAgentTestClient;
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
): Effect.Effect<AgentTestClient, PropertyInvariantViolation, Scope.Scope> {
  return makeAgentTestClient({
    serverUrl: ctx.realServer.wsUrl,
    agentKey: agent.apiKey,
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
  }).pipe(
    Effect.mapError((e) =>
      violation(
        SETUP_FAILURE_PROPERTY,
        `makeAgentTestClient(${agent.name}) failed: ${unwrapError(e)}`,
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
    const client = yield* makeCloseableAgentTestClient({
      serverUrl: ctx.realServer.wsUrl,
      agentKey: agent.apiKey,
      defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    }).pipe(
      Effect.mapError((e) =>
        violation(
          SETUP_FAILURE_PROPERTY,
          `makeCloseableAgentTestClient(${agent.name}) failed: ${unwrapError(e)}`,
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
 * The Effect stream callback notification surface only emits frames that arrive
 * AFTER materialisation. Conformance properties rely on a "subscribe
 * AFTER trigger" pattern; bridge by installing a long-lived pump at
 * handle-construction time that buffers each per-definition frame into an
 * unbounded Queue. `waitFor*` consumes from the Queue, so a frame that
 * arrives before the wait is still observed.
 */
interface ReleaseBuffer {
  readonly queue: Queue.Queue<NotificationDelivery<typeof dispatchRelease>>;
}

function buildRecipientHandle(
  acquired: AcquiredCloseableClient,
): Effect.Effect<RecipientHandle, never, Scope.Scope> {
  return Effect.gen(function* () {
    const queue =
      yield* Queue.unbounded<NotificationDelivery<typeof dispatchRelease>>();
    yield* Effect.forkScoped(
      acquired.client.subscribe(dispatchRelease).pipe(
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
    .sendRpc(dispatchRequest, {
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
          `agent/dispatch/request failed: ${unwrapError(e)}`,
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
  // Pull from the per-handle Queue populated by the long-lived
  // `subscribe(DispatchRelease)` pump installed in `buildRecipientHandle`.
  // The Queue buffers frames that arrive before the wait, so properties
  // call `waitForRelease` AFTER the triggering RPC without races.
  return takeMatchingFromQueue(buffer.queue, timeoutMs, predicate).pipe(
    Effect.mapError((reason) =>
      reason === "timeout"
        ? releaseWaitTimeoutFailure(timeoutMs)
        : violation(
            "recipient.waitForRelease",
            `agent/dispatch/released wait failed: ${reason}`,
          ),
    ),
  );
}

/**
 * Helper: pull frames off a Queue until `predicate` matches, or fail
 * with `"timeout"` after `timeoutMs`. Used by both `waitForRelease`
 * and `waitForObservability` to share the polling-style match loop.
 * @param queue Value supplied to the operation.
 * @param timeoutMs Maximum time to wait in milliseconds.
 * @param predicate Predicate used to select matching values.
 * @returns The take matching from queue result.
 */
function takeMatchingFromQueue<A>(
  queue: Queue.Queue<A>,
  timeoutMs: number,
  predicate?: (frame: A) => boolean,
): Effect.Effect<A, "timeout"> {
  const deadline = Date.now() + timeoutMs;
  const loop: Effect.Effect<A, "timeout"> = Effect.gen(function* () {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return yield* Effect.fail("timeout" as const);
    }
    const frame = yield* Queue.take(queue).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(remaining),
        onTimeout: () => "timeout" as const,
      }),
    );
    if (predicate === undefined || predicate(frame)) {
      return frame;
    }
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
      acquired.client.sendRpc(messagesSend, {
        taskId: params.taskId,
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

function messageSendSuccess(result: ResultOf<typeof messagesSend>): {
  readonly messageId: Schema.Schema.Type<typeof messageId>;
} {
  return {
    messageId: result.message.id,
  };
}

function messageSendFailure(
  exit: Exit.Exit<unknown, unknown>,
): Effect.Effect<
  Extract<SendWithLeaseResult, { readonly errorTag: string }>,
  PropertyFailure
> {
  const rpcErr = firstRpcResponseError(exit);
  if (rpcErr === null) {
    return Effect.fail(
      violation(
        "recipient.sendWithLease",
        `agent/message/send failed without RpcResponseError: ${exitCauseSummary(exit)}`,
      ),
    );
  }
  const errorState = rpcErrorState(rpcErr);
  return Effect.succeed({
    errorTag: rpcErr.tag,
    ...(errorState !== undefined ? { errorState } : {}),
  });
}

function rpcErrorState(error: RpcResponseError): string | undefined {
  const data = error.data;
  if (data === null || typeof data !== "object") {
    return undefined;
  }
  const state: unknown = Reflect.get(data, "state");
  return typeof state === "string" ? state : undefined;
}

interface DispatchAuthorizePredicateInput {
  readonly taskId: Schema.Schema.Type<typeof taskIdSchema>;
  readonly conversationId: Schema.Schema.Type<typeof conversationIdSchema>;
  readonly messageId: Schema.Schema.Type<typeof messageId>;
}

interface ModeratorHandleOptions {
  readonly agent: TestAgent;
  readonly client: AppTestClient;
  readonly appId: string;
  readonly app: TestApp;
}

interface DriverAgents {
  readonly moderatorAgent: TestAgent;
  readonly recipientAgent: TestAgent;
}

interface DriverClients {
  /** Agent connection — drives the agent-called `agent/task/request`. */
  readonly moderatorClient: AgentTestClient;

  /**
   * App-principal `AppConnection` — hosts the moderator callbacks and
   * the app-only RPCs (app/conversation/create, add-participant,
   * app/dispatch/lease/get).
   */
  readonly appClient: AppTestClient;
  readonly recipientAcquired: AcquiredCloseableClient;
}

interface DriverFixtures {
  readonly taskId: Schema.Schema.Type<typeof taskIdSchema>;
  readonly conversationId: Schema.Schema.Type<typeof conversationIdSchema>;
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
  readonly moderatorClient: AppTestClient;
  readonly taskId: Schema.Schema.Type<typeof taskIdSchema>;
  readonly conversationId: Schema.Schema.Type<typeof conversationIdSchema>;
  readonly opts: Parameters<DispatchTestDriver["addRecipient"]>[0];
}

interface LeaseStateTimeoutInput {
  readonly dispatchId: Schema.Schema.Type<typeof dispatchIdSchema>;
  readonly expected: LeaseState;
  readonly bound: number;
  readonly last: LeaseState | null;
  readonly lastError: string | null;
}

/**
 * Per-`ModeratorHandle` Queue buffers for the two observability
 * notification kinds. Long-lived pumps subscribe to each definition at
 * handle-construction time and offer arrivals; the
 * `waitForObservability` API consumes the matching queue.
 */
interface ObservabilityBuffers {
  readonly consumed: Queue.Queue<
    NotificationDelivery<typeof dispatchLeaseConsumed>
  >;
  readonly expired: Queue.Queue<
    NotificationDelivery<typeof dispatchLeaseExpired>
  >;
}

function buildModeratorHandle(
  opts: ModeratorHandleOptions,
): Effect.Effect<ModeratorHandle, never, Scope.Scope> {
  return Effect.gen(function* () {
    const consumed =
      yield* Queue.unbounded<
        NotificationDelivery<typeof dispatchLeaseConsumed>
      >();
    const expired =
      yield* Queue.unbounded<
        NotificationDelivery<typeof dispatchLeaseExpired>
      >();
    yield* Effect.forkScoped(
      opts.client.subscribe(dispatchLeaseConsumed).pipe(
        Stream.runForEach((frame) => Queue.offer(consumed, frame)),
        Effect.catchAll(() => Effect.void),
      ),
    );
    yield* Effect.forkScoped(
      opts.client.subscribe(dispatchLeaseExpired).pipe(
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
  app: TestApp,
  cfg: Parameters<ModeratorHandle["handleAuthorize"]>[0],
): Effect.Effect<void, PropertyFailure> {
  return app.dispatchAuthorize.handle({
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

function silenceAuthorize(app: TestApp): Effect.Effect<void, PropertyFailure> {
  return app.dispatchAuthorize.silence;
}

function authorizePredicateInput(
  params: ServerRpcParams<typeof dispatchAuthorize>,
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
  // Pull from the per-handle Queue populated by the long-lived
  // `subscribe(DispatchLeaseConsumed|Expired)` pumps installed in
  // `buildModeratorHandle`. The Queue buffers frames that arrive before
  // the wait, so properties call `waitForObservability` after the
  // triggering action (e.g. `advanceTime`) without races.
  const take: Effect.Effect<ObservabilityFrame, "timeout"> =
    kind === "consumed"
      ? takeMatchingFromQueue(buffers.consumed, timeoutMs, (frame) =>
          matchesDispatchId(frame.params, opts.dispatchId),
        )
      : takeMatchingFromQueue(buffers.expired, timeoutMs, (frame) =>
          matchesDispatchId(frame.params, opts.dispatchId),
        );
  return take.pipe(
    Effect.map(
      (frame) =>
        /* Safe because the selected queue is determined by the same kind K. */ frame as ObservabilityNotification<K>,
    ),
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
  | NotificationDelivery<typeof dispatchLeaseConsumed>
  | NotificationDelivery<typeof dispatchLeaseExpired>;

function observabilityViolation(
  kind: "consumed" | "expired",
  reason: string,
): PropertyFailure {
  return violation(`moderator.waitForObservability(${kind})`, reason);
}

function matchesDispatchId(
  params: unknown,
  dispatchId?: Schema.Schema.Type<typeof dispatchIdSchema>,
): boolean {
  if (dispatchId === undefined) {
    return true;
  }
  return (
    typeof params === "object" &&
    params !== null &&
    Reflect.get(params, "dispatchId") === dispatchId
  );
}

function getLease(
  client: AppTestClient,
  dispatchId: Schema.Schema.Type<typeof dispatchIdSchema>,
): ReturnType<ModeratorHandle["getLease"]> {
  return client.sendRpc(dispatchLeaseGet, { dispatchId }).pipe(
    Effect.map(leaseResultFromWire),
    Effect.mapError((e) =>
      violation(
        "moderator.getLease",
        `app/dispatch/lease/get failed: ${unwrapError(e)}`,
      ),
    ),
  );
}

function leaseResultFromWire(result: ResultOf<typeof dispatchLeaseGet>): {
  readonly state: LeaseState;
  readonly verdict: DispatchVerdict | null;
  readonly leaseId: Schema.Schema.Type<typeof leaseId>;
} {
  const lease = result.lease;
  return {
    state: lease.state,
    verdict: verdictFromWire(lease.verdict),
    // The wire `leaseId` is a server-minted UUID; decode it through the brand
    // schema rather than a bare cast (the brand is an Effect `Schema`).
    leaseId: Schema.decodeUnknownSync(leaseId)(lease.leaseId),
  };
}

/**
 * Acquire a fully-wired driver under the surrounding `Scope`. Releases
 * close every lifecycle client + drop the connected app registration.
 *
 * Property authors call this from inside their property body; the driver
 * is per-property, never shared. Cross-property state leakage is the
 * exact failure mode the per-property scope prevents.
 * @param ctx Context for the operation.
 * @param config Documentation generation configuration.
 * @param config.moderatorTimeoutMs Value supplied to the operation.
 * @returns The created dispatch test driver.
 */
export function makeDispatchTestDriver(
  ctx: ConformanceRunContext,
  config?: { readonly moderatorTimeoutMs?: number },
): Effect.Effect<DispatchTestDriver, PropertyFailure, Scope.Scope> {
  const moderatorTimeoutMs =
    config?.moderatorTimeoutMs ?? DEFAULT_MODERATOR_TIMEOUT_MS;
  return Effect.gen(function* () {
    const agents = yield* acquireDriverAgents(ctx);
    // Register the moderator app FIRST (HTTP + `appKey` Connect → an
    // `AppConnection`); `agent/task/request` then targets the server-minted
    // `appId`. App-only RPCs + moderator callbacks + `app/dispatch/lease/get`
    // route through `app.client`; the agent `moderatorClient` only drives
    // the agent-called `agent/task/request`.
    const app = yield* registerDriverApp(ctx, moderatorTimeoutMs);
    const clients = yield* acquireDriverClients(ctx, agents, app);
    const fixtures = yield* createDriverFixtures(
      clients,
      app.appId,
      agents.recipientAgent,
    );
    const recipient = yield* buildRecipientHandle(clients.recipientAcquired);
    const moderator = yield* buildModeratorHandle({
      agent: agents.moderatorAgent,
      client: clients.appClient,
      appId: app.appId,
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
  app: TestApp,
): Effect.Effect<DriverClients, PropertyFailure, Scope.Scope> {
  return Effect.gen(function* () {
    return {
      moderatorClient: yield* acquireSharedClient(ctx, agents.moderatorAgent),
      appClient: app.client,
      recipientAcquired: yield* acquireCloseableClient(
        ctx,
        agents.recipientAgent,
      ),
    };
  });
}

function registerDriverApp(
  ctx: ConformanceRunContext,
  moderatorTimeoutMs: number,
): Effect.Effect<TestApp, PropertyFailure, Scope.Scope> {
  return Effect.gen(function* () {
    const app = yield* registerTestApp({
      baseUrl: ctx.realServer.baseUrl,
      wsUrl: ctx.realServer.wsUrl,
      manifest: makeTestAppManifest({
        appId: globalThis.crypto.randomUUID(),
        name: "Conformance Dispatch Test App",
        dispatchAuthorizeTimeoutMs: moderatorTimeoutMs,
      }),
    }).pipe(
      Effect.mapError((e) =>
        violation(SETUP_FAILURE_PROPERTY, `app registration failed: ${e._tag}`),
      ),
    );
    // Remote apps must answer `app/message/authorize` or the server's
    // wire-callback round-trip times out (fail-closed Block). The
    // dispatch-admission properties assert lease lifecycle events,
    // not message routing — `Forward { recipients: [] }` is sufficient
    // and matches the "store, don't fan out" intent.
    yield* app.messagesAuthorize.handle({
      respondWith: {
        verdict: { decision: "Forward" as const, recipients: [] },
      },
    });
    return app;
  });
}

function createDriverFixtures(
  clients: DriverClients,
  appId: Schema.Schema.Type<typeof appIdSchema>,
  recipientAgent: TestAgent,
): Effect.Effect<DriverFixtures, PropertyFailure> {
  // `agent/task/request` is agent-called (the moderator agent); the app-only
  // `app/conversation/create` routes through the app principal.
  return Effect.gen(function* () {
    const taskId = yield* createDriverTask(
      clients.moderatorClient,
      appId,
      recipientAgent,
    );
    const conversationId = yield* createDriverConversation(
      clients.appClient,
      taskId,
      recipientAgent,
    );
    return { taskId, conversationId };
  });
}

function createDriverTask(
  moderatorClient: AgentTestClient,
  appId: Schema.Schema.Type<typeof appIdSchema>,
  recipientAgent: TestAgent,
): Effect.Effect<Schema.Schema.Type<typeof taskIdSchema>, PropertyFailure> {
  return moderatorClient
    .sendRpc(taskRequest, {
      appId,
      invitedAgentIds: [recipientAgent.agentId],
    })
    .pipe(
      Effect.map((result) => result.task.id),
      Effect.mapError((e) =>
        violation(
          SETUP_FAILURE_PROPERTY,
          `app/task/create failed: ${unwrapError(e)}`,
        ),
      ),
    );
}

function createDriverConversation(
  moderatorClient: AppTestClient,
  taskId: Schema.Schema.Type<typeof taskIdSchema>,
  recipientAgent: TestAgent,
): Effect.Effect<
  Schema.Schema.Type<typeof conversationIdSchema>,
  PropertyFailure
> {
  return moderatorClient
    .sendRpc(conversationCreate, {
      taskId,
      name: "conformance-dispatch-conv",
      participants: [recipientAgent.agentId],
    })
    .pipe(
      Effect.map((result) => result.conversation.id),
      Effect.mapError((e) =>
        violation(
          SETUP_FAILURE_PROPERTY,
          `app/conversation/create failed: ${unwrapError(e)}`,
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
        // Task and conversation mutations are app-called; route through the app
        // principal.
        moderatorClient: parts.clients.appClient,
        taskId: parts.fixtures.taskId,
        conversationId: parts.fixtures.conversationId,
        opts,
      }),
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
    yield* addTaskParticipant(input.moderatorClient, input.taskId, agent);
    yield* addConversationParticipant(
      input.moderatorClient,
      input.taskId,
      input.conversationId,
      agent,
    );
    return yield* buildRecipientHandle(acquired);
  });
}

function addTaskParticipant(
  moderatorClient: AppTestClient,
  taskId: Schema.Schema.Type<typeof taskIdSchema>,
  agent: TestAgent,
): Effect.Effect<void, PropertyFailure> {
  return moderatorClient
    .sendRpc(taskUpdate, {
      action: "add-participant",
      taskId,
      agentId: agent.agentId,
    })
    .pipe(
      Effect.mapError((e) =>
        violation(
          "driver.addRecipient",
          `app/task/update failed: ${unwrapError(e)}`,
        ),
      ),
    );
}

function addConversationParticipant(
  moderatorClient: AppTestClient,
  taskId: Schema.Schema.Type<typeof taskIdSchema>,
  conversationId: Schema.Schema.Type<typeof conversationIdSchema>,
  agent: TestAgent,
): Effect.Effect<void, PropertyFailure> {
  return moderatorClient
    .sendRpc(conversationUpdate, {
      action: "add-participant",
      taskId,
      conversationId,
      agentId: agent.agentId,
    })
    .pipe(
      Effect.mapError((e) =>
        violation(
          "driver.addRecipient",
          `app/conversation/update failed: ${unwrapError(e)}`,
        ),
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
  dispatchId: Schema.Schema.Type<typeof dispatchIdSchema>,
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
        if (last === expected) {
          return;
        }
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

// ── Re-export wire types for property authors ─────────────────────────

/** Re-exports the public API from `#message/dispatch`. */
export type {
  dispatchRelease,
  dispatchLeaseConsumed,
  dispatchLeaseExpired,
} from "#message/dispatch";
