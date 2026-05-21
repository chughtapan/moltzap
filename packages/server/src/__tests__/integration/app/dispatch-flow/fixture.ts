import {
  DEFAULT_APP_ID,
  DispatchRelease,
  DispatchRequest,
  MessagesSend,
  TaskConversationParticipantsRemovedNotificationDefinition,
  TaskCreate,
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
  getTestCoreApp,
  resetTestDbEffect,
  startTestServerEffect,
  stopTestServerEffect,
  type ConnectedAgent,
} from "../../helpers.js";

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

export function createModeratedDm(
  alice: ConnectedAgent,
  bob: ConnectedAgent,
  manifest: AppManifest,
): Effect.Effect<ConversationBinding, unknown> {
  return Effect.gen(function* () {
    const result = yield* alice.client.sendRpc(TaskCreate, {
      appId: manifest.appId,
      invitedAgentIds: [bob.agentId],
      initialConversation: { participants: [bob.agentId] },
    });
    return {
      taskId: result.task.id,
      conversationId: result.conversation!.id,
    };
  }).pipe(Effect.withSpan("createModeratedDm"));
}

export function createUnmoderatedDm(
  alice: ConnectedAgent,
  bob: ConnectedAgent,
): Effect.Effect<ConversationBinding, unknown> {
  return Effect.gen(function* () {
    const conv = yield* alice.client.sendRpc(TaskCreate, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
      initialConversation: { participants: [bob.agentId] },
    });
    return { taskId: conv.task.id, conversationId: conv.conversation!.id };
  }).pipe(Effect.withSpan("createUnmoderatedDm"));
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

export function createDispatchFlowFixture(manifest: AppManifest) {
  let hookCalls = 0;
  let nextHookVerdict: DispatchHookVerdict = { decision: "grant" };

  const authorizeDispatch = () =>
    Effect.runPromise(
      Effect.gen(function* () {
        hookCalls += 1;
        const verdict = nextHookVerdict;
        if ("kind" in verdict && verdict.kind === "never-reply") {
          return yield* Effect.never;
        }
        return verdict;
      }).pipe(Effect.withSpan("dispatchFlow.authorizeHook")),
    );

  const reset = resetTestDbEffect().pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        hookCalls = 0;
        nextHookVerdict = { decision: "grant" };
        const coreApp = getTestCoreApp();
        coreApp.registerApp(manifest);
        coreApp.onTaskAuthorizeDispatch(manifest.appId, authorizeDispatch);
      }),
    ),
    Effect.withSpan("dispatchFlow.reset"),
  );

  return {
    reset,
    hookCalls: () => hookCalls,
    setNextHookVerdict: (verdict: DispatchHookVerdict) => {
      nextHookVerdict = verdict;
    },
  };
}
