import {
  DispatchAuthorize,
  DispatchRelease,
  DispatchRequest,
  MessagesAuthorize,
  MessagesSend,
  TaskConversationParticipantsRemovedNotificationDefinition,
  TaskCreate,
  TaskRequest,
  type AppCallbackContext,
  type AppCallbackHandlers,
  type AppId,
  type AppManifest,
  type ConversationId,
  type DispatchId,
  type LeaseId,
  type TaskId,
} from "@moltzap/protocol";
import {
  agentId as protocolAgentId,
  messageId,
} from "@moltzap/protocol/testing";
import { Effect } from "effect";
import {
  awaitOneNotification,
  connectAppClient,
  getTestCoreApp,
  registerApp,
  resetTestDbEffect,
  startTestServerEffect,
  stopTestServerEffect,
  type ConnectedAgent,
  type TestAppClient,
} from "../../helpers.js";
import { getBaseUrl } from "../../../../test-utils/index.js";

type GrantVerdict = {
  readonly decision: "grant";
  readonly leaseTimeoutMs?: number;
};
type DenyVerdict = { readonly decision: "deny"; readonly reason?: string };
type HoldVerdict = { readonly decision: "hold"; readonly reason?: string };
type HookVerdict = GrantVerdict | DenyVerdict | HoldVerdict;

export type DispatchHookVerdict =
  | HookVerdict
  | { readonly kind: "never-reply" };

export const EXPECTED_TYPE_STRING = "string";
export const DISPATCH_STATE_GRANTED = "GRANTED";
export const DISPATCH_STATE_EXPIRED = "EXPIRED";
export const DISPATCH_STATE_ABANDONED = "ABANDONED";
export const DISPATCH_STATE_CONSUMED = "CONSUMED";
export const DISPATCH_VERDICT_GRANT = "grant";
export const DISPATCH_VERDICT_DENY = "deny";
export const DISPATCH_VERDICT_HOLD = "hold";
export const MODERATOR_UNAVAILABLE_REASON = "moderator_unavailable";
export const MODERATOR_TIMEOUT_REASON = "timeout";
export const DISPATCH_RELEASE_TIMEOUT_MS = 5_000;
export const DISPATCH_REQUEST_CONCURRENCY = 2;

export interface ConversationBinding {
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
}

export const startDispatchFlowServer = () =>
  Effect.runPromise(startTestServerEffect());

export const stopDispatchFlowServer = () =>
  Effect.runPromise(stopTestServerEffect());

export const makeProbeMessageId = () => messageId(crypto.randomUUID());

/**
 * D #705 CP9 — create a task + conversation under the fixture's
 * moderator app. The app is minted via the `/api/v1/apps/register` HTTP
 * endpoint (DB-issued `appId`) and a SEPARATE app client `appKey`-Connects
 * (disjoint principal); its implicit registration binds that connection as
 * the app's moderator endpoint. `task/request` is sent by `alice` (the
 * requesting AGENT, R1) and targets the DB-minted `appId`. The caller MUST
 * have wired the moderator callbacks (via {@link attachDispatchAuthorizeHook})
 * BEFORE calling this — the server resolves the forked moderator round-trip
 * on the first `dispatch/request`. `manifest.appId` is ignored; the manifest
 * supplies the hook declarations (so the server's hookless fast-path does NOT
 * short-circuit to a synthetic grant) + conversation defaults.
 */
export function createTaskConversationOnApp(
  alice: ConnectedAgent,
  bob: ConnectedAgent,
  manifest: AppManifest,
): Effect.Effect<ConversationBinding, unknown> {
  return Effect.gen(function* () {
    const appId = yield* ensureModeratorApp(manifest);
    const result = yield* alice.client.sendRpc(TaskRequest, {
      appId,
      invitedAgentIds: [bob.agentId],
      initialConversation: { participants: [bob.agentId] },
    });
    return {
      taskId: result.task.id,
      conversationId: result.conversation!.id,
    };
  }).pipe(Effect.withSpan("createTaskConversationOnApp"));
}

/**
 * Per-test moderator-app state: the DB-minted `appId` + the live
 * `AppConnection` client whose constructor-supplied handlers answer the
 * server→client moderator round-trips. Memoized per manifest so a test that
 * creates several conversations under one moderator reuses one app client.
 */
interface ModeratorApp {
  readonly appId: AppId;
  readonly client: TestAppClient;
}

let moderatorApp: ModeratorApp | null = null;
let attachedFixture: DispatchFlowFixture | null = null;

const MODERATOR_HOOK_TIMEOUT_MS = 5_000;

/**
 * Hook policy set for a moderated dispatch app: `dispatch_authorize` is
 * `kind: "hook"` so the server round-trips the admission decision to the
 * app's connection (the fixture answers it via {@link setNextHookVerdict}).
 * `task_create` stays `accept` (static) — these scenarios exercise the
 * dispatch lifecycle, so the task auto-accepts in-process. Dispatch-flow
 * manifests declare `hooks: MODERATED_HOOKS` directly.
 */
export const MODERATED_HOOKS: AppManifest["hooks"] = {
  dispatch_authorize: { kind: "hook", timeoutMs: MODERATOR_HOOK_TIMEOUT_MS },
  message_authorize: { kind: "forwardAllExceptSender" },
  task_create: { kind: "accept" },
};

function ensureModeratorApp(
  manifest: AppManifest,
): Effect.Effect<AppId, unknown> {
  return Effect.gen(function* () {
    if (moderatorApp !== null) return moderatorApp.appId;
    const registered = yield* registerApp(getBaseUrl(), manifest);
    const client = yield* connectAppClient(
      registered.appId,
      registered.appKey,
      moderatorHandlers(),
    );
    moderatorApp = { appId: registered.appId, client };
    return registered.appId;
  }).pipe(Effect.withSpan("ensureModeratorApp"));
}

function moderatorHandlers(): AppCallbackHandlers<AppCallbackContext> {
  return {
    "dispatch/authorize": {
      definition: DispatchAuthorize,
      handle: () =>
        Effect.gen(function* () {
          if (attachedFixture === null) return yield* Effect.never;
          const verdict = attachedFixture.consumeNextVerdict();
          if ("kind" in verdict) return yield* Effect.never;
          return { admission: verdict };
        }).pipe(Effect.withSpan("dispatchFlow.dispatchAuthorize")),
    },
    "messages/authorize": {
      definition: MessagesAuthorize,
      handle: () => Effect.dieMessage("unexpected messages/authorize"),
    },
    "task/create": {
      definition: TaskCreate,
      handle: () =>
        Effect.succeed({ verdict: { decision: "accept" as const } }),
    },
  };
}

/**
 * Reset the per-test moderator-app state. Called from
 * {@link DispatchFlowFixture.reset}; `reset` closes all clients (including the
 * moderator app client) via `resetTestDbEffect → closeAllClients`, so the
 * stale `ModeratorApp` reference is dropped here before the next test
 * re-mints one.
 */
function resetModeratorAppState(): void {
  moderatorApp = null;
  attachedFixture = null;
}

/**
 * Arm the fixture's moderator callbacks. The verdict callback lives on the
 * fixture's app `AppConnection` (a disjoint principal from `alice`), so this
 * records the active fixture whose `consumeNextVerdict` the callback consults;
 * the actual handler table is installed at app-client connect time.
 * Call BEFORE
 * {@link createTaskConversationOnApp} so the verdict source is live by the
 * time the server forks the moderator round-trip on `dispatch/request`.
 */
export function attachDispatchAuthorizeHook(
  _alice: ConnectedAgent,
  fixture: DispatchFlowFixture,
): Effect.Effect<void> {
  return Effect.sync(() => {
    attachedFixture = fixture;
  });
}

/**
 * The fixture's moderator `AppConnection` client — the disjoint principal
 * bound as the app's moderator endpoint. `dispatches/get` is moderator-scoped
 * (the calling connection MUST be the lease's `moderatorConnectionId`), so a
 * test asserting that scope reads via THIS client, not the requesting agent.
 * Throws if no conversation has been created yet (the app client is minted
 * lazily by {@link createTaskConversationOnApp}).
 */
export function moderatorAppClient(): TestAppClient {
  if (moderatorApp === null) {
    throw new Error(
      "moderatorAppClient: no moderator app — call createTaskConversationOnApp first",
    );
  }
  return moderatorApp.client;
}

export function requestDispatch(
  recipient: ConnectedAgent,
  conversationId: ConversationId,
  sender: ConnectedAgent,
  text = "probe",
) {
  return recipient.client.sendRpc(DispatchRequest, {
    conversationId,
    messageId: makeProbeMessageId(),
    senderAgentId: protocolAgentId(sender.agentId),
    parts: [{ type: "text", text }],
  });
}

export function sendMessageWithLease(
  sender: ConnectedAgent,
  binding: ConversationBinding,
  leaseId: LeaseId,
  text: string,
) {
  return sender.client.sendRpc(MessagesSend, {
    taskId: binding.taskId,
    conversationId: binding.conversationId,
    parts: [{ type: "text", text }],
    dispatchLeaseId: leaseId,
  });
}

/**
 * Spec B (#596) r2 cleanup: notification helpers return a `Fiber` that the
 * caller MUST acquire BEFORE issuing the trigger RPC. The underlying
 * `Stream.async` subscription has no historical buffer — if the helper
 * subscribed after the trigger, notifications firing in the gap between
 * trigger-return and subscription-registration are lost.
 *
 * Caller pattern (fork-before-trigger + Fiber.join):
 * ```
 * const releaseFiber = yield* waitForDispatchRelease(bob);
 * yield* requestDispatch(bob, ...);
 * const release = yield* Fiber.join(releaseFiber);
 * ```
 *
 * Returning a `Fiber` (rather than the raw Effect) makes the contract
 * structural — the type signature enforces fork-before-trigger because
 * callers receive a fiber handle, not the awaited value.
 */
export function waitForDispatchRelease(
  recipient: ConnectedAgent,
  timeoutMs = DISPATCH_RELEASE_TIMEOUT_MS,
) {
  return Effect.fork(
    awaitOneNotification(recipient.client, DispatchRelease, timeoutMs).pipe(
      Effect.map((notification) => notification.params),
      Effect.withSpan("waitForDispatchRelease"),
    ),
  );
}

export function waitForParticipantsRemoved(
  recipient: ConnectedAgent,
  timeoutMs = DISPATCH_RELEASE_TIMEOUT_MS,
) {
  return Effect.fork(
    awaitOneNotification(
      recipient.client,
      TaskConversationParticipantsRemovedNotificationDefinition,
      timeoutMs,
    ).pipe(
      Effect.map((notification) => notification.params),
      Effect.withSpan("waitForParticipantsRemoved"),
    ),
  );
}

export function readLeaseByLeaseId(leaseId: LeaseId) {
  return getTestCoreApp()
    .leaseRegistry.read({
      _tag: "leaseId",
      value: leaseId,
    })
    .pipe(Effect.withSpan("readLeaseByLeaseId"));
}

export function readLeaseByDispatchId(dispatchId: DispatchId) {
  return getTestCoreApp()
    .leaseRegistry.read({
      _tag: "dispatchId",
      value: dispatchId,
    })
    .pipe(Effect.withSpan("readLeaseByDispatchId"));
}

export interface DispatchFlowFixture {
  readonly reset: Effect.Effect<void, unknown>;
  hookCalls(): number;
  setNextHookVerdict(verdict: DispatchHookVerdict): void;
  /** Used by {@link attachDispatchAuthorizeHook}; do not call from tests. */
  consumeNextVerdict(): DispatchHookVerdict;
}

export function createDispatchFlowFixture(
  _manifest: AppManifest,
): DispatchFlowFixture {
  let hookCalls = 0;
  let nextHookVerdict: DispatchHookVerdict = { decision: "grant" };

  return {
    reset: resetTestDbEffect().pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          hookCalls = 0;
          nextHookVerdict = { decision: "grant" };
          resetModeratorAppState();
        }),
      ),
      Effect.withSpan("dispatchFlow.reset"),
    ),
    hookCalls: () => hookCalls,
    setNextHookVerdict: (verdict) => {
      nextHookVerdict = verdict;
    },
    consumeNextVerdict: () => {
      hookCalls += 1;
      return nextHookVerdict;
    },
  };
}
