/**
 * #529 reshape additive — `dispatch/{request, authorize, release}` +
 * `dispatches/{consumed, expired, get}` admission surface.
 *
 * Bucket file: `verdicts` group. Split from `dispatch-flow.integration.test.ts`
 * (Phase 2B reorg, #543). Each split file owns its own server-fixture
 * `beforeAll`/`afterAll`/`beforeEach` so vitest's `fileParallelism: true`
 * runner can execute buckets concurrently without sharing state.
 *
 * See parent dispatch-flow architecture comment in the original file
 * (now replaced by these 6 bucket files): the recipient calls
 * `dispatch/request` over WS; server mints a lease, returns ack
 * synchronously, forks the moderator round-trip; recipient observes
 * the verdict via `dispatch/release` notification. `messages/send(
 * dispatchLeaseId=X)` consumes the lease via `Effect.acquireUseRelease(
 * claim, sendInsert+commit, finalize|rollback)`.
 */
import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  AppsRegister,
  ConversationsArchive,
  ConversationsCreate,
  DispatchAuthorize,
  DispatchRequest,
  DispatchRelease,
  DispatchesGet,
  MessagesSend,
  ParticipantsRemovedNotificationDefinition,
  TasksCreate,
  TasksCreateConversation,
  type AppManifest,
  type ConversationId,
  type DispatchId,
  type LeaseId,
  type MessageId,
} from "@moltzap/protocol";
import { agentId as protocolAgentId } from "@moltzap/protocol/testing";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
  setupAgentPair,
  getTestCoreApp,
} from "../../helpers.js";

const TEST_APP_ID = "moderator-dispatch-test-app";

const TEST_APP_MANIFEST: AppManifest = {
  appId: TEST_APP_ID,
  name: "Moderator Dispatch Test App",
  conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
};

let hookCalls = 0;
let nextHookVerdict:
  | { decision: "grant"; leaseTimeoutMs?: number }
  | { decision: "deny"; reason?: string }
  | { decision: "hold"; reason?: string }
  | { kind: "never-reply" } = { decision: "grant" };

beforeAll(async () => {
  await startTestServer();
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
  hookCalls = 0;
  nextHookVerdict = { decision: "grant" };
  const coreApp = getTestCoreApp();
  coreApp.registerApp(TEST_APP_MANIFEST);
  coreApp.onTaskAuthorizeDispatch(TEST_APP_ID, async () => {
    hookCalls += 1;
    const v = nextHookVerdict;
    if ("kind" in v && v.kind === "never-reply") {
      // Never resolves — server-side timeout fires.
      await new Promise(() => {
        /* never */
      });
    }
    return v as
      | { decision: "grant"; leaseTimeoutMs?: number }
      | { decision: "deny"; reason?: string }
      | { decision: "hold"; reason?: string };
  });
});

function makeProbeMessageId(): MessageId {
  return crypto.randomUUID() as MessageId;
}

describe("dispatch/* — verdict flows (#529 reshape additive)", () => {
  // Scenario 3 — deny path
  it.live(
    "deny path: moderator deny → dispatch/release{deny} fires",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        nextHookVerdict = { decision: "deny", reason: "phase closed" };
        const task = yield* alice.client.sendRpc(TasksCreate, {
          appId: TEST_APP_ID,
          tmType: "self",
        });
        const conv = yield* alice.client.sendRpc(TasksCreateConversation, {
          taskId: task.task.id,
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        });
        const ack = yield* bob.client.sendRpc(DispatchRequest, {
          conversationId: conv.conversation.id,
          messageId: makeProbeMessageId(),
          senderAgentId: protocolAgentId(alice.agentId),
          parts: [{ type: "text", text: "probe" }],
        });
        const release = yield* bob.client.waitForNotification(
          DispatchRelease,
          5000,
        );
        const params = release.params as {
          leaseId: string;
          verdict: { decision: string; reason?: string };
        };
        expect(params.leaseId).toBe(ack.leaseId);
        expect(params.verdict.decision).toBe("deny");
        expect(params.verdict.reason).toBe("phase closed");
      }),
    20_000,
  );

  // Scenario 4 — hold path
  it.live(
    "hold path: moderator hold → dispatch/release{hold} fires",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        nextHookVerdict = { decision: "hold", reason: "waiting for turn" };
        const task = yield* alice.client.sendRpc(TasksCreate, {
          appId: TEST_APP_ID,
          tmType: "self",
        });
        const conv = yield* alice.client.sendRpc(TasksCreateConversation, {
          taskId: task.task.id,
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        });
        const ack = yield* bob.client.sendRpc(DispatchRequest, {
          conversationId: conv.conversation.id,
          messageId: makeProbeMessageId(),
          senderAgentId: protocolAgentId(alice.agentId),
          parts: [{ type: "text", text: "probe" }],
        });
        const release = yield* bob.client.waitForNotification(
          DispatchRelease,
          5000,
        );
        const params = release.params as {
          leaseId: string;
          verdict: { decision: string };
        };
        expect(params.leaseId).toBe(ack.leaseId);
        expect(params.verdict.decision).toBe("hold");
      }),
    20_000,
  );

  // ── Scenario 5 — moderator timeout (architect §8 #5, plan risk #3) ──
  //
  // Architect plan §8 #5: "moderator never responds → dispatch/release
  // {deny, reason: \"timeout\"} fires + participants/removed fires".
  // Synthesized timeout-deny IS verdict-deny per architect risk #3 + #5
  // — both arms call `removeParticipant`. Synthesized infra-hold (no
  // hook registered, see scenario 17) does NOT (architect risk #5,
  // epic decision #10). The deny → removeParticipant wire is in
  // `app-host.ts`'s `runForkedDispatchRoundTrip` deny arm. Authority:
  // `requireConversationAdminAuthority` (prereq 2) accepts the
  // moderator's agentId because `task.app_id IS NOT NULL` and
  // `task.tm_endpoint_address === tm:agent:<moderatorAgentId>`.
  it.live(
    "moderator timeout: never-reply hook → dispatch/release{deny, reason: timeout} + participants/removed fires (architect §8 #5)",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        nextHookVerdict = { kind: "never-reply" };
        // Default DEFAULT_APP_HOOK_TIMEOUT_MS is 5000ms; assert against
        // that. (Architect plan §3.4: timeout source is manifest
        // hooks.dispatch_authorize.timeout_ms ?? DEFAULT_APP_HOOK_TIMEOUT_MS.)
        const task = yield* alice.client.sendRpc(TasksCreate, {
          appId: TEST_APP_ID,
          tmType: "self",
        });
        const conv = yield* alice.client.sendRpc(TasksCreateConversation, {
          taskId: task.task.id,
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        });
        const ack = yield* bob.client.sendRpc(DispatchRequest, {
          conversationId: conv.conversation.id,
          messageId: makeProbeMessageId(),
          senderAgentId: protocolAgentId(alice.agentId),
          parts: [{ type: "text", text: "probe" }],
        });
        // Wait long enough for the 5s server-side timeout to fire.
        const release = yield* bob.client.waitForNotification(
          DispatchRelease,
          10_000,
        );
        const params = release.params as {
          leaseId: string;
          verdict: { decision: string; reason?: string };
        };
        expect(params.leaseId).toBe(ack.leaseId);
        expect(params.verdict.decision).toBe("deny");
        expect(params.verdict.reason).toBe("timeout");
        // Architect §8 #5: participants/removed fires alongside
        // dispatch/release{deny}. The participants/removed broadcast
        // includes the about-to-be-removed agent (snapshot taken
        // BEFORE the delete), so bob (the recipient being removed)
        // observes the notification on his own connection.
        const removed = yield* bob.client.waitForNotification(
          ParticipantsRemovedNotificationDefinition,
          5000,
        );
        const removedParams = removed.params as {
          conversationId: string;
          agentId: string;
        };
        expect(removedParams.conversationId).toBe(conv.conversation.id);
        expect(removedParams.agentId).toBe(bob.agentId);
      }),
    25_000,
  );

  // ── Scenario 5b — verdict-deny → participants/removed (architect §8 #3) ─
  //
  // Companion to scenario 5: explicit-deny (moderator returns {deny})
  // also triggers removeParticipant. Distinct from scenario 3 above
  // (which only asserts the dispatch/release arm).
  it.live(
    "verdict-deny: moderator deny → dispatch/release{deny} + participants/removed fires",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        nextHookVerdict = { decision: "deny", reason: "phase closed" };
        const task = yield* alice.client.sendRpc(TasksCreate, {
          appId: TEST_APP_ID,
          tmType: "self",
        });
        const conv = yield* alice.client.sendRpc(TasksCreateConversation, {
          taskId: task.task.id,
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        });
        const ack = yield* bob.client.sendRpc(DispatchRequest, {
          conversationId: conv.conversation.id,
          messageId: makeProbeMessageId(),
          senderAgentId: protocolAgentId(alice.agentId),
          parts: [{ type: "text", text: "probe" }],
        });
        const release = yield* bob.client.waitForNotification(
          DispatchRelease,
          5000,
        );
        const params = release.params as {
          leaseId: string;
          verdict: { decision: string; reason?: string };
        };
        expect(params.leaseId).toBe(ack.leaseId);
        expect(params.verdict.decision).toBe("deny");
        const removed = yield* bob.client.waitForNotification(
          ParticipantsRemovedNotificationDefinition,
          5000,
        );
        const removedParams = removed.params as {
          conversationId: string;
          agentId: string;
        };
        expect(removedParams.conversationId).toBe(conv.conversation.id);
        expect(removedParams.agentId).toBe(bob.agentId);
      }),
    20_000,
  );
});
