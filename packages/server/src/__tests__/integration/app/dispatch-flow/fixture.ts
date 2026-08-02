import {
  dispatchAuthorize,
  dispatchRelease,
  dispatchRequest,
  type DispatchId,
  type LeaseId,
} from "@moltzap/protocol/message/dispatch";
import { messagesAuthorize, messagesSend } from "@moltzap/protocol/message";
import {
  agentConversationCreate,
  conversationParticipantsRemovedNotificationDefinition,
  type ConversationId,
} from "@moltzap/protocol/conversation";
import type {
  AppCallbackContext,
  AppCallbackHandlers,
} from "@moltzap/protocol/socket";
import type { AppId, AppManifest } from "@moltzap/protocol/identity";
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
import { getBaseUrl } from "../../../../test-utils/server.js";

interface GrantVerdict {
  readonly decision: "grant";
  readonly leaseTimeoutMs?: number;
}
interface DenyVerdict {
  readonly decision: "deny";
  readonly reason?: string;
}
interface HoldVerdict {
  readonly decision: "hold";
  readonly reason?: string;
}
type HookVerdict = GrantVerdict | DenyVerdict | HoldVerdict;

/** Represents dispatch hook verdict values. */
export type DispatchHookVerdict =
  | HookVerdict
  | { readonly kind: "never-reply" };

/** Provides the expected type string runtime value. */
export const EXPECTED_TYPE_STRING = "string";
/** Provides the dispatch state granted runtime value. */
export const DISPATCH_STATE_GRANTED = "GRANTED";
/** Provides the dispatch state expired runtime value. */
export const DISPATCH_STATE_EXPIRED = "EXPIRED";
/** Provides the dispatch state abandoned runtime value. */
export const DISPATCH_STATE_ABANDONED = "ABANDONED";
/** Provides the dispatch state consumed runtime value. */
export const DISPATCH_STATE_CONSUMED = "CONSUMED";
/** Provides the dispatch verdict grant runtime value. */
export const DISPATCH_VERDICT_GRANT = "grant";
/** Provides the dispatch verdict deny runtime value. */
export const DISPATCH_VERDICT_DENY = "deny";
/** Provides the dispatch verdict hold runtime value. */
export const DISPATCH_VERDICT_HOLD = "hold";
/** Provides the moderator unavailable reason runtime value. */
export const MODERATOR_UNAVAILABLE_REASON = "moderator_unavailable";
/** Provides the moderator timeout reason runtime value. */
export const MODERATOR_TIMEOUT_REASON = "timeout";
/** Provides the dispatch release timeout ms runtime value. */
export const DISPATCH_RELEASE_TIMEOUT_MS = 5_000;
/** Provides the dispatch request concurrency runtime value. */
export const DISPATCH_REQUEST_CONCURRENCY = 2;

/** Describes conversation binding. */
export interface ConversationBinding {
  readonly conversationId: ConversationId;
}

/**
 * Provides the start dispatch flow server runtime value.
 * @returns The created conversation on app.
 */
export const startDispatchFlowServer = () =>
  Effect.runPromise(startTestServerEffect());

/**
 * Provides the stop dispatch flow server runtime value.
 * @returns The created conversation on app.
 */
export const stopDispatchFlowServer = () =>
  Effect.runPromise(stopTestServerEffect());

/**
 * Provides the make probe message id runtime value.
 * @returns The created conversation on app.
 */
export const makeProbeMessageId = () => messageId(crypto.randomUUID());

/**
 * Create a conversation under the fixture's moderator app. The app is minted
 * through app registration, connects as a separate `AppConnection`, and binds
 * that connection as the app's moderator endpoint. `agent/conversation/create`
 * is sent by `alice` and names the DB-minted `appId` as the conversation's
 * routing key. The caller must attach the moderator callbacks before calling
 * this; the server resolves the forked moderator round-trip on the first
 * `agent/dispatch/request`. `manifest.appId` is ignored; the manifest supplies
 * hook declarations and conversation defaults.
 * @param alice Value supplied to the operation.
 * @param bob Value supplied to the operation.
 * @param manifest Value supplied to the operation.
 * @returns The created conversation on app.
 */
export function createConversationOnApp(
  alice: ConnectedAgent,
  bob: ConnectedAgent,
  manifest: AppManifest,
): Effect.Effect<ConversationBinding, unknown> {
  return Effect.gen(function* () {
    const appId = yield* ensureModeratorApp(manifest);
    const result = yield* alice.client.sendRpc(agentConversationCreate, {
      appId,
      participants: [bob.agentId],
    });
    return { conversationId: result.conversation.id };
  }).pipe(Effect.withSpan("createConversationOnApp"));
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
 * Dispatch-flow manifests declare `hooks: MODERATED_HOOKS` directly.
 */
export const MODERATED_HOOKS: AppManifest["hooks"] = {
  dispatch_authorize: { kind: "hook", timeoutMs: MODERATOR_HOOK_TIMEOUT_MS },
  message_authorize: { kind: "forwardAllExceptSender" },
};

function ensureModeratorApp(
  manifest: AppManifest,
): Effect.Effect<AppId, unknown> {
  return Effect.gen(function* () {
    if (moderatorApp !== null) {
      return moderatorApp.appId;
    }
    const registered = yield* registerApp(getBaseUrl(), manifest);
    const client = yield* connectAppClient(
      registered.appId,
      registered.appKey,
      moderatorHandlers(),
    );
    // The fixture is reset between tests and acquired serially by each test.
    // eslint-disable-next-line require-atomic-updates -- No concurrent fixture acquisition occurs within a test.
    moderatorApp = { appId: registered.appId, client };
    return registered.appId;
  }).pipe(Effect.withSpan("ensureModeratorApp"));
}

function moderatorHandlers(): AppCallbackHandlers<AppCallbackContext> {
  return {
    [dispatchAuthorize.name]: {
      definition: dispatchAuthorize,
      handle: () =>
        Effect.gen(function* () {
          if (attachedFixture === null) {
            return yield* Effect.never;
          }
          const verdict = attachedFixture.consumeNextVerdict();
          if ("kind" in verdict) {
            return yield* Effect.never;
          }
          return { admission: verdict };
        }).pipe(Effect.withSpan("dispatchFlow.dispatchAuthorize")),
    },
    [messagesAuthorize.name]: {
      definition: messagesAuthorize,
      handle: () => Effect.dieMessage("unexpected app/message/authorize"),
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
 * {@link createConversationOnApp} so the verdict source is live by the
 * time the server forks the moderator round-trip on `agent/dispatch/request`.
 * @param fixture Value supplied to the operation.
 * @returns The attach dispatch authorize hook result.
 */
export function attachDispatchAuthorizeHook(
  fixture: DispatchFlowFixture,
): Effect.Effect<void> {
  return Effect.sync(() => {
    attachedFixture = fixture;
  });
}

/**
 * The fixture's moderator `AppConnection` client — the disjoint principal
 * bound as the app's moderator endpoint. `app/dispatch/lease/get` is moderator-scoped
 * (the calling connection MUST be the lease's `moderatorConnectionId`), so a
 * test asserting that scope reads via THIS client, not the requesting agent.
 * Throws if no conversation has been created yet (the app client is minted
 * lazily by {@link createConversationOnApp}).
 * @returns The moderator app client result.
 */
export function moderatorAppClient(): TestAppClient {
  if (moderatorApp === null) {
    throw new Error(
      "moderatorAppClient: no moderator app — call createConversationOnApp first",
    );
  }
  return moderatorApp.client;
}

/**
 * Executes the request dispatch operation.
 * @param recipient Value supplied to the operation.
 * @param conversationId Value supplied to the operation.
 * @param sender Value supplied to the operation.
 * @param text Text to process.
 * @returns The request dispatch result.
 */
export function requestDispatch(
  recipient: ConnectedAgent,
  conversationId: ConversationId,
  sender: ConnectedAgent,
  text = "probe",
) {
  return requestDispatchOutcome(recipient, conversationId, sender, text).pipe(
    Effect.flatMap((outcome) =>
      "outcome" in outcome
        ? Effect.dieMessage("expected a minted dispatch lease")
        : Effect.succeed(outcome),
    ),
  );
}

/**
 * Executes a dispatch request without narrowing the declared busy outcome.
 * @param recipient Value supplied to the operation.
 * @param conversationId Value supplied to the operation.
 * @param sender Value supplied to the operation.
 * @param text Text to process.
 * @returns Minted lease identifiers, or `conversation_busy` with no lease.
 */
export function requestDispatchOutcome(
  recipient: ConnectedAgent,
  conversationId: ConversationId,
  sender: ConnectedAgent,
  text = "probe",
) {
  return recipient.client.sendRpc(dispatchRequest, {
    conversationId,
    messageId: makeProbeMessageId(),
    senderAgentId: protocolAgentId(sender.agentId),
    parts: [{ type: "text", text }],
  });
}

/**
 * Sends message with lease.
 * @param sender Value supplied to the operation.
 * @param binding Value supplied to the operation.
 * @param leaseId Value supplied to the operation.
 * @param text Text to process.
 * @returns The send message with lease result.
 */
export function sendMessageWithLease(
  sender: ConnectedAgent,
  binding: ConversationBinding,
  leaseId: LeaseId,
  text: string,
) {
  return sender.client.sendRpc(messagesSend, {
    conversationId: binding.conversationId,
    parts: [{ type: "text", text }],
    dispatchLeaseId: leaseId,
  });
}

/**
 * Notification helpers return a `Fiber` that the caller must acquire before
 * issuing the trigger RPC. The underlying `Stream.async` subscription has no
 * historical buffer.
 *
 * Caller pattern (fork-before-trigger + Fiber.join):.
 * ```
 * const releaseFiber = yield* waitForDispatchRelease(bob);
 * yield* requestDispatch(bob, ...);
 * const release = yield* Fiber.join(releaseFiber);
 * ```
 *
 * Returning a `Fiber` (rather than the raw Effect) makes the contract
 * structural — the type signature enforces fork-before-trigger because
 * callers receive a fiber handle, not the awaited value.
 * @param recipient Value supplied to the operation.
 * @param timeoutMs Maximum time to wait in milliseconds.
 * @returns The wait for dispatch release result.
 */
export function waitForDispatchRelease(
  recipient: ConnectedAgent,
  timeoutMs = DISPATCH_RELEASE_TIMEOUT_MS,
) {
  return Effect.fork(
    awaitOneNotification(recipient.client, dispatchRelease, timeoutMs).pipe(
      Effect.map((notification) => notification.params),
      Effect.withSpan("waitForDispatchRelease"),
    ),
  );
}

/**
 * Waits for for participants removed.
 * @param recipient Value supplied to the operation.
 * @param timeoutMs Maximum time to wait in milliseconds.
 * @returns The wait for participants removed result.
 */
export function waitForParticipantsRemoved(
  recipient: ConnectedAgent,
  timeoutMs = DISPATCH_RELEASE_TIMEOUT_MS,
) {
  return Effect.fork(
    awaitOneNotification(
      recipient.client,
      conversationParticipantsRemovedNotificationDefinition,
      timeoutMs,
    ).pipe(
      Effect.map((notification) => notification.params),
      Effect.withSpan("waitForParticipantsRemoved"),
    ),
  );
}

/**
 * Reads lease by lease id.
 * @param leaseId Value supplied to the operation.
 * @returns The read lease by lease id result.
 */
export function readLeaseByLeaseId(leaseId: LeaseId) {
  return getTestCoreApp()
    .leaseRegistry.read({
      _tag: "leaseId",
      value: leaseId,
    })
    .pipe(Effect.withSpan("readLeaseByLeaseId"));
}

/**
 * Reads lease by dispatch id.
 * @param dispatchId Value supplied to the operation.
 * @returns The read lease by dispatch id result.
 */
export function readLeaseByDispatchId(dispatchId: DispatchId) {
  return getTestCoreApp()
    .leaseRegistry.read({
      _tag: "dispatchId",
      value: dispatchId,
    })
    .pipe(Effect.withSpan("readLeaseByDispatchId"));
}

/** Describes dispatch flow fixture. */
export interface DispatchFlowFixture {
  readonly reset: Effect.Effect<void, unknown>;
  hookCalls(): number;
  setNextHookVerdict(verdict: DispatchHookVerdict): void;
  /** Used by {@link attachDispatchAuthorizeHook}; do not call from tests. */
  consumeNextVerdict(): DispatchHookVerdict;
}

/**
 * Creates dispatch flow fixture.
 * @returns The created dispatch flow fixture.
 */
export function createDispatchFlowFixture(): DispatchFlowFixture {
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
