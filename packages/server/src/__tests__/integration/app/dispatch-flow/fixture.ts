import {
  ConversationsCreate,
  DispatchRelease,
  DispatchRequest,
  MessagesSend,
  ParticipantsRemovedNotificationDefinition,
  TasksCreate,
  TasksCreateConversation,
  type AppManifest,
  type ConversationId,
  type DispatchId,
  type LeaseId,
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

export const startDispatchFlowServer = () =>
  Effect.runPromise(startTestServerEffect());

export const stopDispatchFlowServer = () =>
  Effect.runPromise(stopTestServerEffect());

export const makeProbeMessageId = () => messageId(crypto.randomUUID());

export function createModeratedDm(
  alice: ConnectedAgent,
  bob: ConnectedAgent,
  appId: string,
) {
  return Effect.gen(function* () {
    const task = yield* alice.client.sendRpc(TasksCreate, {
      appId,
      tmType: "self",
    });
    const conv = yield* alice.client.sendRpc(TasksCreateConversation, {
      taskId: task.task.id,
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    });
    return conv.conversation.id;
  }).pipe(Effect.withSpan("createModeratedDm"));
}

export function createUnmoderatedDm(
  alice: ConnectedAgent,
  bob: ConnectedAgent,
) {
  return Effect.gen(function* () {
    const conv = yield* alice.client.sendRpc(ConversationsCreate, {
      type: "dm",
      participants: [{ type: "agent", id: bob.agentId }],
    });
    return conv.conversation.id;
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
  conversationId: ConversationId,
  leaseId: LeaseId,
  text: string,
) {
  return sender.client.sendRpc(MessagesSend, {
    conversationId,
    parts: [{ type: "text", text }],
    dispatchLeaseId: leaseId,
  });
}

export function waitForDispatchRelease(
  recipient: ConnectedAgent,
  timeoutMs = DISPATCH_RELEASE_TIMEOUT_MS,
) {
  // Spec B (#596): subscribe via the Stream API. The fixture is invoked
  // from `Effect.gen` blocks that have already issued the trigger RPC by
  // the time control reaches this helper, so the lazy Stream value is
  // materialised the moment the caller starts pulling — option (a)
  // subscribe-before-trigger per spec Goal #7 is enforced by the
  // caller's structural use (fork + trigger + join).
  return awaitOneNotification(
    recipient.client,
    DispatchRelease,
    timeoutMs,
  ).pipe(
    Effect.map((notification) => notification.params),
    Effect.withSpan("waitForDispatchRelease"),
  );
}

export function waitForParticipantsRemoved(
  recipient: ConnectedAgent,
  timeoutMs = DISPATCH_RELEASE_TIMEOUT_MS,
) {
  return awaitOneNotification(
    recipient.client,
    ParticipantsRemovedNotificationDefinition,
    timeoutMs,
  ).pipe(
    Effect.map((notification) => notification.params),
    Effect.withSpan("waitForParticipantsRemoved"),
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
