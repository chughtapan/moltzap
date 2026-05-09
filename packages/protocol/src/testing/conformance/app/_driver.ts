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
 * existing `TestClient` primitives (`sendRpc`, `handleServerRpc`,
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
import { Cause, Chunk, Duration, Effect, Exit, Scope } from "effect";
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
} from "../../../task/methods.js";
import type { TaskId } from "../../../task/tasks.js";
import {
  AppsRegister,
  DispatchAuthorize,
  DispatchRelease,
  DispatchRequest,
  DispatchesConsumed,
  DispatchesExpired,
  DispatchesGet,
  type AppManifest,
  type DispatchId,
  type LeaseId,
} from "../../../app/index.js";
import type { DecodedNotification } from "../../../transport/rpc-groups.js";
import { registerTestAgent, type TestAgent } from "../_shared/test-fixtures.js";
import {
  makeCloseableTestClient,
  makeTestClient,
  type CloseableTestClient,
  type TestClient,
} from "../_shared/driver/test-client.js";

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
const RANDOM_SUFFIX_BASE = 36;
const RANDOM_SUFFIX_PREFIX_LEN = 2;
const RANDOM_SUFFIX_LEN = 6;
const RANDOM_SUFFIX_END = RANDOM_SUFFIX_PREFIX_LEN + RANDOM_SUFFIX_LEN;

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

function verdictToWire(verdict: DispatchVerdict): {
  readonly admission:
    | { decision: "grant"; leaseTimeoutMs?: number }
    | { decision: "deny"; reason?: string }
    | { decision: "hold"; reason?: string };
} {
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
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") return null;
  const obj = raw as {
    decision?: unknown;
    reason?: unknown;
    leaseTimeoutMs?: unknown;
  };
  if (obj.decision === "grant") {
    return typeof obj.leaseTimeoutMs === "number"
      ? { _tag: "grant", leaseTimeoutMs: obj.leaseTimeoutMs }
      : { _tag: "grant" };
  }
  if (obj.decision === "deny") {
    return typeof obj.reason === "string"
      ? { _tag: "deny", reason: obj.reason }
      : { _tag: "deny" };
  }
  if (obj.decision === "hold") {
    return typeof obj.reason === "string"
      ? { _tag: "hold", reason: obj.reason }
      : { _tag: "hold" };
  }
  return null;
}

function buildManifest(appId: string, moderatorTimeoutMs: number): AppManifest {
  return {
    appId,
    name: "Conformance Dispatch Test App",
    conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
    hooks: { dispatch_authorize: { timeout_ms: moderatorTimeoutMs } },
  };
}

type DispatchIdParamsView = { readonly dispatchId?: Static<typeof DispatchId> };

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

function buildRecipientHandle(
  acquired: AcquiredCloseableClient,
): RecipientHandle {
  const sendRequestDispatch = (params: {
    readonly conversationId: Static<typeof ConversationId>;
    readonly messageId: Static<typeof MessageId>;
    readonly senderAgentId: Static<typeof AgentId>;
    readonly attempt?: number;
  }) =>
    acquired.client
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

  const waitForRelease: RecipientHandle["waitForRelease"] = (
    predicate,
    timeoutMs = DEFAULT_WAIT_FOR_RELEASE_MS,
  ) =>
    Effect.gen(function* () {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return yield* Effect.fail(
            violation(
              "recipient.waitForRelease",
              `timeout after ${timeoutMs}ms`,
            ),
          );
        }
        const frame = yield* acquired.client
          .waitForNotification(DispatchRelease, remaining)
          .pipe(
            Effect.mapError((e) =>
              violation(
                "recipient.waitForRelease",
                `dispatch/release wait failed: ${e.message}`,
              ),
            ),
          );
        if (predicate === undefined || predicate(frame)) {
          return frame;
        }
        // Mismatched frame — keep waiting.
      }
    });

  const sendWithLease: RecipientHandle["sendWithLease"] = (params) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        acquired.client.sendRpc(MessagesSend, {
          conversationId: params.conversationId,
          parts: [{ type: "text", text: params.text }],
          dispatchLeaseId: params.leaseId,
        }),
      );
      if (Exit.isSuccess(exit)) {
        const result = exit.value as {
          message: { id: Static<typeof MessageId> };
        };
        return { messageId: result.message.id };
      }
      // Surface the typed RpcResponseError's code + the
      // `data.state` field the server attaches on LeaseInvalid
      // (see `messages.handlers.ts` ForbiddenError mapping). Properties
      // pattern-match on errorCode/errorState to assert the
      // CONSUMED/EXPIRED transitions.
      const rpcErr = firstRpcResponseError(exit);
      if (rpcErr === null) {
        return yield* Effect.fail(
          violation(
            "recipient.sendWithLease",
            `messages/send failed without RpcResponseError: ${String(exit.cause).slice(0, ERROR_CAUSE_TRUNCATE_LEN)}`,
          ),
        );
      }
      const data = (rpcErr.data ?? {}) as { state?: unknown };
      const errorState =
        typeof data.state === "string" ? data.state : undefined;
      return {
        // PLACEHOLDER messageId for the error path — the property MUST
        // pattern-match on errorCode before reading messageId. The brand
        // wrapper is satisfied by an empty string in the failure case;
        // if the property reads `messageId` on the error path it gets a
        // non-UUID and the assertion fails loudly downstream.
        messageId: "" as Static<typeof MessageId>,
        errorCode: rpcErr.code,
        ...(errorState !== undefined ? { errorState } : {}),
      };
    });

  const hardClose: Effect.Effect<void, PropertyFailure> = acquired.client.close;

  return {
    agentId: acquired.agent.agentId,
    requestDispatch: sendRequestDispatch,
    waitForRelease,
    sendWithLease,
    hardClose,
  } satisfies RecipientHandle;
}

interface HandlerEntry {
  readonly cfg: {
    readonly respondWith: DispatchVerdict;
    readonly predicate?: (params: {
      readonly taskId: Static<typeof TaskId>;
      readonly conversationId: Static<typeof ConversationId>;
      readonly messageId: Static<typeof MessageId>;
    }) => boolean;
    readonly holdResponseFor?: number;
  };
}

function buildModeratorHandle(opts: {
  readonly agent: TestAgent;
  readonly client: TestClient;
  readonly appId: string;
  readonly handlersRef: {
    value: ReadonlyArray<HandlerEntry>;
    silenced: boolean;
  };
}): ModeratorHandle {
  const handleAuthorize: ModeratorHandle["handleAuthorize"] = (cfg) =>
    Effect.sync(() => {
      // Append to the handler list. The driver's dispatcher (installed
      // once at construction time) walks this list per inbound
      // `dispatch/authorize` request and picks the first entry whose
      // predicate matches; if no predicate is set, the entry catches
      // everything. Last-registered with `predicate=undefined` wins
      // for unfiltered cases; per-message predicates carve out specific
      // request flows. This mirrors the architect plan §3 "request-by-
      // request scripting via predicate" pattern.
      opts.handlersRef.value = [...opts.handlersRef.value, { cfg }];
      opts.handlersRef.silenced = false;
    });

  const silenceAuthorize: Effect.Effect<void, PropertyFailure> = Effect.sync(
    () => {
      // Mark silenced — the dispatcher's inbound matcher returns
      // `Effect.never` (hold forever) so the server-side TTL fires and
      // synthesizes deny.
      opts.handlersRef.silenced = true;
      opts.handlersRef.value = [];
    },
  );

  const waitForObservability: ModeratorHandle["waitForObservability"] = (
    kind,
    opts2,
  ) => {
    const definition =
      kind === "consumed" ? DispatchesConsumed : DispatchesExpired;
    const timeoutMs = opts2.timeoutMs ?? DEFAULT_OBSERVABILITY_TIMEOUT_MS;
    return Effect.gen(function* () {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return yield* Effect.fail(
            violation(
              `moderator.waitForObservability(${kind})`,
              `timeout after ${timeoutMs}ms`,
            ),
          );
        }
        const frame = yield* opts.client
          .waitForNotification(definition, remaining)
          .pipe(
            Effect.mapError((e) =>
              violation(
                `moderator.waitForObservability(${kind})`,
                `notification wait failed: ${e.message}`,
              ),
            ),
          );
        if (
          opts2.dispatchId === undefined ||
          (frame.params as DispatchIdParamsView).dispatchId === opts2.dispatchId
        ) {
          // The decoder constrains the param shape to the right
          // notification per the wire schema.
          return frame as never;
        }
      }
    });
  };

  const getLease: ModeratorHandle["getLease"] = (dispatchId) =>
    opts.client.sendRpc(DispatchesGet, { dispatchId }).pipe(
      Effect.map((result) => {
        const lease = (result as { lease: Record<string, unknown> }).lease;
        return {
          state: lease["state"] as LeaseState,
          verdict: verdictFromWire(lease["verdict"]),
          leaseId: lease["leaseId"] as Static<typeof LeaseId>,
        };
      }),
      Effect.mapError((e) =>
        violation(
          "moderator.getLease",
          `dispatches/get failed: ${unwrapError(e)}`,
        ),
      ),
    );

  return {
    agentId: opts.agent.agentId,
    appId: opts.appId,
    handleAuthorize,
    silenceAuthorize,
    waitForObservability,
    getLease,
  } satisfies ModeratorHandle;
}

/**
 * Install a single dispatcher on the moderator's TestClient that walks
 * `handlersRef` per inbound `dispatch/authorize` request. The dispatcher
 * is installed ONCE at driver construction time; subsequent
 * `handleAuthorize` calls just push entries onto the ref. This avoids
 * the race where last-wins overwrite of `handleServerRpc` could lose
 * a still-in-flight first-request hold (architect plan §7
 * `release-for-one-lease-does-not-wait-on-another` row).
 */
function installModeratorAuthorizeDispatcher(
  client: TestClient,
  handlersRef: { value: ReadonlyArray<HandlerEntry>; silenced: boolean },
): Effect.Effect<void> {
  // Inbound `dispatch/authorize` params shape per `DispatchAuthorize`
  // descriptor — narrowed locally so the handler can read `taskId` /
  // `conversationId` / `message.id` via a single typed cast.
  type AuthorizeParams = {
    readonly taskId: Static<typeof TaskId>;
    readonly conversationId: Static<typeof ConversationId>;
    readonly message: { readonly id: Static<typeof MessageId> };
  };
  type AuthorizeResult = {
    readonly admission:
      | { decision: "grant"; leaseTimeoutMs?: number }
      | { decision: "deny"; reason?: string }
      | { decision: "hold"; reason?: string };
  };
  return client.handleServerRpc(
    DispatchAuthorize,
    (params): Effect.Effect<AuthorizeResult, RpcResponseError> => {
      if (handlersRef.silenced) {
        // Hold forever — server-side TTL fires, synthesizes deny.
        // `Effect.never` widens to `Effect<never, never, never>`,
        // which is assignable to any (Result, Error) pair without
        // casting.
        return Effect.never;
      }
      const ctx = params as AuthorizeParams;
      const predicateInput = {
        taskId: ctx.taskId,
        conversationId: ctx.conversationId,
        messageId: ctx.message.id,
      };
      // Walk in registration order; first matching predicate wins. An
      // entry without a predicate matches everything (catch-all).
      const entry = handlersRef.value.find((e) => {
        const pred = e.cfg.predicate;
        return pred === undefined || pred(predicateInput);
      });
      if (entry === undefined) {
        // No registered handler for this inbound — hold forever
        // (server synthesizes deny on its moderator-response TTL).
        return Effect.never;
      }
      const wire = verdictToWire(entry.cfg.respondWith);
      const reply = Effect.succeed(wire);
      if (
        entry.cfg.holdResponseFor !== undefined &&
        entry.cfg.holdResponseFor > 0
      ) {
        return Effect.sleep(Duration.millis(entry.cfg.holdResponseFor)).pipe(
          Effect.zipRight(reply),
        );
      }
      return reply;
    },
  );
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
  const moderatorTimeoutMs =
    config?.moderatorTimeoutMs ?? DEFAULT_MODERATOR_TIMEOUT_MS;
  const taskAppId = config?.taskAppId;
  // Each driver gets a fresh appId so cross-property runs (sharing the
  // same RealServerHandle) do not collide on the same manifest.
  const appId =
    taskAppId === null
      ? null
      : (taskAppId ?? `conformance-dispatch-app-${cryptoRandomShort()}`);

  return Effect.gen(function* () {
    // 1) Register agents (HTTP). Moderator + first recipient.
    // Names stay under the server's 32-char limit + alphanumeric end
    // (`^[a-z0-9][a-z0-9_-]{1,30}[a-z0-9]$`). The HTTP register helper
    // appends `-${suffix}` (~7 chars), so the prefix MUST be ≤ 24
    // chars to keep the suffixed total under 32.
    const moderatorAgent = yield* acquireAgent(ctx, "conf-mod");
    const recipientAgent = yield* acquireAgent(ctx, "conf-rcpt");

    // 2) Open WS clients. Moderator stays open under the property scope;
    // recipient is closeable so `hardClose` can drop it on demand.
    const moderatorClient = yield* acquireSharedClient(ctx, moderatorAgent);
    const recipientAcquired = yield* acquireCloseableClient(
      ctx,
      recipientAgent,
    );

    // 3) For app-bound runs, register the app over the wire so the
    // moderator's connection becomes the routing target for
    // `dispatch/authorize`. (Server-side `apps/register` records the
    // manifest + the calling connection id; subsequent task creation
    // referencing this `appId` will dispatch admission via the moderator's
    // S→C channel.)
    if (appId !== null) {
      const manifest = buildManifest(appId, moderatorTimeoutMs);
      yield* moderatorClient
        .sendRpc(AppsRegister, { manifest })
        .pipe(
          Effect.mapError((e) =>
            violation(
              SETUP_FAILURE_PROPERTY,
              `apps/register failed: ${unwrapError(e)}`,
            ),
          ),
        );
    }

    // 4) Create a task bound to the app (or no app for default-grant) and
    // a DM conversation containing the recipient.
    const taskParams =
      appId !== null
        ? { appId, tmType: "self" as const }
        : { tmType: "self" as const };
    const taskResult = yield* moderatorClient
      .sendRpc(TasksCreate, taskParams)
      .pipe(
        Effect.mapError((e) =>
          violation(
            SETUP_FAILURE_PROPERTY,
            `tasks/create failed: ${unwrapError(e)}`,
          ),
        ),
      );
    const task = (taskResult as { task: { id: Static<typeof TaskId> } }).task;

    const convResult = yield* moderatorClient
      .sendRpc(TasksCreateConversation, {
        taskId: task.id,
        // `group` (not `dm`) so `addRecipient` can extend the participant
        // roster for the same-conversation-concurrency property; DM is
        // capped at 2 participants. Single-recipient properties still
        // exercise the same admission code path.
        type: "group",
        name: "conformance-dispatch-conv",
        participants: [{ type: "agent" as const, id: recipientAgent.agentId }],
      })
      .pipe(
        Effect.mapError((e) =>
          violation(
            SETUP_FAILURE_PROPERTY,
            `tasks/createConversation failed: ${unwrapError(e)}`,
          ),
        ),
      );
    const conversation = (
      convResult as {
        conversation: { id: Static<typeof ConversationId> };
      }
    ).conversation;

    const recipient = buildRecipientHandle(recipientAcquired);
    // Per-driver mutable ref of authorize handler entries. The dispatcher
    // installed on the moderator client walks this ref on every inbound
    // `dispatch/authorize`; properties append entries via
    // `moderator.handleAuthorize` or set `silenced` via
    // `moderator.silenceAuthorize`.
    const handlersRef = {
      value: [] as ReadonlyArray<HandlerEntry>,
      silenced: false,
    };
    yield* installModeratorAuthorizeDispatcher(moderatorClient, handlersRef);
    const moderator = buildModeratorHandle({
      agent: moderatorAgent,
      client: moderatorClient,
      // For default-grant runs there is no `appId`; getLease /
      // dispatches-get scope is keyed by `moderatorConnectionId` only
      // when an app exists. We surface the empty string so the typed
      // surface still has a string; properties that read `appId` are
      // app-bound.
      appId: appId ?? "",
      handlersRef,
    });

    // ── addRecipient: spawn another recipient client + ensure it sits
    // inside the same conversation. Adds a fresh agent identity, opens
    // a TestClient, and adds the agent as a conversation participant
    // via `tasks/addParticipant` (the conversation lives under a task,
    // so participant edits go through the task RPC).
    const addRecipient: DispatchTestDriver["addRecipient"] = (recipientOpts) =>
      Effect.gen(function* () {
        const name = recipientOpts.agentName ?? "conf-rcpt2";
        const agent = yield* acquireAgent(ctx, name);
        const acquired2 = yield* acquireCloseableClient(ctx, agent);
        // Add the agent to the existing conversation by replacing the
        // moderator's task-participant list. Use the wire RPC.
        yield* moderatorClient
          .sendRpc(ConversationsAddParticipant, {
            conversationId: conversation.id,
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
        return buildRecipientHandle(acquired2);
      });

    // ── getLeaseFromNonModerator: spawn a third-party client, issue
    // dispatches/get, expect the typed ForbiddenError code (-32001).
    // The third-party client closes when the parent scope closes; we
    // attach it directly to the surrounding scope.
    const getLeaseFromNonModerator: DispatchTestDriver["getLeaseFromNonModerator"] =
      (dispatchId) =>
        Effect.gen(function* () {
          // Reuse the recipient client — it is a non-moderator on the
          // wire (its connection is not the moderator's). The architect
          // plan #533 §7's mapping table notes that the property uses
          // `driver.getLeaseFromNonModerator(dispatchId)` returning the
          // server's typed error code; the recipient-as-non-moderator
          // is the canonical case.
          const exit = yield* Effect.exit(
            recipientAcquired.client.sendRpc(DispatchesGet, { dispatchId }),
          );
          if (Exit.isSuccess(exit)) {
            return yield* Effect.fail(
              violation(
                "driver.getLeaseFromNonModerator",
                `dispatches/get unexpectedly succeeded for non-moderator caller`,
              ),
            );
          }
          const rpcErr = firstRpcResponseError(exit);
          if (rpcErr === null) {
            return yield* Effect.fail(
              violation(
                "driver.getLeaseFromNonModerator",
                `dispatches/get failed without RpcResponseError: ${String(exit.cause).slice(0, ERROR_CAUSE_TRUNCATE_LEN)}`,
              ),
            );
          }
          return { errorCode: rpcErr.code };
        });

    // ── assertLeaseState: poll moderator's dispatches/get every 25 ms
    // until the state reaches `expected` or the bound elapses.
    const assertLeaseState: DispatchTestDriver["assertLeaseState"] = (
      dispatchId,
      expected,
      assertOpts,
    ) =>
      Effect.gen(function* () {
        const bound =
          assertOpts?.timeoutMs ?? DEFAULT_ASSERT_LEASE_STATE_BOUND_MS;
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
        return yield* Effect.fail(
          violation(
            "driver.assertLeaseState",
            `lease ${dispatchId} did not reach ${expected} within ${bound}ms (last=${last ?? "<unread>"}, lastError=${lastError ?? "<none>"})`,
          ),
        );
      });

    const advanceTime: DispatchTestDriver["advanceTime"] = (durationMs) =>
      Effect.sleep(Duration.millis(durationMs));

    return {
      recipient,
      moderator,
      fixtures: { taskId: task.id, conversationId: conversation.id },
      addRecipient,
      getLeaseFromNonModerator,
      assertLeaseState,
      advanceTime,
    } satisfies DispatchTestDriver;
  });
}

// ── Crypto helper for unique appId (avoids `crypto` import noise) ─────
function cryptoRandomShort(): string {
  // Avoid pulling node:crypto into the protocol's testing surface; the
  // 6-char suffix is enough to disambiguate per-property instances
  // within one conformance run.
  return Math.random()
    .toString(RANDOM_SUFFIX_BASE)
    .slice(RANDOM_SUFFIX_PREFIX_LEN, RANDOM_SUFFIX_END);
}

// ── Re-export wire types for property authors ─────────────────────────

export type {
  DispatchRelease,
  DispatchesConsumed,
  DispatchesExpired,
} from "../../../app/index.js";
