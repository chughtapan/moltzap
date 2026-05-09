/**
 * #529 reshape additive — `dispatch/{request, authorize, release}` +
 * `dispatches/{consumed, expired, get}` admission surface.
 *
 * Bucket file: `concurrency` group. Split from `dispatch-flow.integration.test.ts`
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

describe("dispatch/* — concurrency (#529 reshape additive)", () => {
  // ── Scenario 11 — cross-conversation concurrency (architect §8 #11) ─
  it.live(
    "cross-conversation concurrency: two dispatch/request in different (taskId, conversationId) → both round-trips concurrent",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        // Two distinct tasks → two distinct conversations.
        const task1 = yield* alice.client.sendRpc(TasksCreate, {
          appId: TEST_APP_ID,
          tmType: "self",
        });
        const conv1 = yield* alice.client.sendRpc(TasksCreateConversation, {
          taskId: task1.task.id,
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        });
        const task2 = yield* alice.client.sendRpc(TasksCreate, {
          appId: TEST_APP_ID,
          tmType: "self",
        });
        const conv2 = yield* alice.client.sendRpc(TasksCreateConversation, {
          taskId: task2.task.id,
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        });
        // Fire two dispatch/request calls in parallel.
        const [ack1, ack2] = yield* Effect.all(
          [
            bob.client.sendRpc(DispatchRequest, {
              conversationId: conv1.conversation.id,
              messageId: makeProbeMessageId(),
              senderAgentId: protocolAgentId(alice.agentId),
              parts: [{ type: "text", text: "first" }],
            }),
            bob.client.sendRpc(DispatchRequest, {
              conversationId: conv2.conversation.id,
              messageId: makeProbeMessageId(),
              senderAgentId: protocolAgentId(alice.agentId),
              parts: [{ type: "text", text: "second" }],
            }),
          ],
          { concurrency: "unbounded" },
        );
        expect(ack1.leaseId).not.toBe(ack2.leaseId);
        // Both moderator round-trips ran (hookCalls === 2) and both
        // produced a release.
        const release1 = yield* bob.client.waitForNotification(
          DispatchRelease,
          5000,
        );
        const release2 = yield* bob.client.waitForNotification(
          DispatchRelease,
          5000,
        );
        const seen = new Set([
          (release1.params as { leaseId: string }).leaseId,
          (release2.params as { leaseId: string }).leaseId,
        ]);
        expect(seen.has(ack1.leaseId)).toBe(true);
        expect(seen.has(ack2.leaseId)).toBe(true);
        expect(hookCalls).toBe(2);
      }),
    25_000,
  );

  // ── Scenario 12 — same-conversation concurrency (architect §8 #12) ──
  // Closes #358 P1: no server-side per-conversation serialization.
  it.live(
    "same-conversation concurrency: two dispatch/request in same (taskId, conversationId) → both round-trips concurrent (no server serialization)",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        const task = yield* alice.client.sendRpc(TasksCreate, {
          appId: TEST_APP_ID,
          tmType: "self",
        });
        const conv = yield* alice.client.sendRpc(TasksCreateConversation, {
          taskId: task.task.id,
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        });
        const [ack1, ack2] = yield* Effect.all(
          [
            bob.client.sendRpc(DispatchRequest, {
              conversationId: conv.conversation.id,
              messageId: makeProbeMessageId(),
              senderAgentId: protocolAgentId(alice.agentId),
              parts: [{ type: "text", text: "first" }],
            }),
            bob.client.sendRpc(DispatchRequest, {
              conversationId: conv.conversation.id,
              messageId: makeProbeMessageId(),
              senderAgentId: protocolAgentId(alice.agentId),
              parts: [{ type: "text", text: "second" }],
            }),
          ],
          { concurrency: "unbounded" },
        );
        // Both leases minted distinct ids (no shared resource serialized them).
        expect(ack1.leaseId).not.toBe(ack2.leaseId);
        expect(ack1.dispatchId).not.toBe(ack2.dispatchId);
        // Two release notifications fire.
        yield* bob.client.waitForNotification(DispatchRelease, 5000);
        yield* bob.client.waitForNotification(DispatchRelease, 5000);
        expect(hookCalls).toBe(2);
      }),
    25_000,
  );
});
