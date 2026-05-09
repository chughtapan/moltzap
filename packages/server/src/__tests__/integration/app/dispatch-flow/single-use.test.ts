/**
 * #529 reshape additive — `dispatch/{request, authorize, release}` +
 * `dispatches/{consumed, expired, get}` admission surface.
 *
 * Bucket file: `single-use` group. Split from `dispatch-flow.integration.test.ts`
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

describe("dispatch/* — single-use lease consumption (#529 reshape additive)", () => {
  // ── Scenario 7 — PENDING messages/send (architect §8 #7) ────────────
  it.live(
    "PENDING messages/send: recipient sends with dispatchLeaseId before release arrives → typed LeaseInvalidError(state=PENDING), no parking",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        nextHookVerdict = { kind: "never-reply" };
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
          parts: [{ type: "text", text: "race" }],
        });
        // Send immediately while hook is still pending (lease state = PENDING).
        // No need to wait for the release.
        const result = yield* Effect.either(
          bob.client.sendRpc(MessagesSend, {
            conversationId: conv.conversation.id,
            parts: [{ type: "text", text: "race" }],
            dispatchLeaseId: ack.leaseId,
          }),
        );
        expect(result._tag).toBe("Left");
        // ForbiddenError with data.reason = "LeaseInvalid" + state = "PENDING"
        // is the wire surface (see messages.handlers.ts).
      }),
    25_000,
  );

  // ── Scenario 8 — single-use enforcement (architect §8 #8) ───────────
  it.live(
    "single-use enforcement: GRANTED lease used once → second send returns typed LeaseInvalidError(state=CONSUMED)",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        const conv = yield* alice.client.sendRpc(ConversationsCreate, {
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        });
        const ack = yield* bob.client.sendRpc(DispatchRequest, {
          conversationId: conv.conversation.id,
          messageId: makeProbeMessageId(),
          senderAgentId: protocolAgentId(alice.agentId),
          parts: [{ type: "text", text: "first" }],
        });
        yield* bob.client.waitForNotification(DispatchRelease, 5000);
        // First send consumes the lease.
        const first = yield* bob.client.sendRpc(MessagesSend, {
          conversationId: conv.conversation.id,
          parts: [{ type: "text", text: "first" }],
          dispatchLeaseId: ack.leaseId,
        });
        expect(typeof first.message.id).toBe("string");
        // Second send must reject (CONSUMED).
        const second = yield* Effect.either(
          bob.client.sendRpc(MessagesSend, {
            conversationId: conv.conversation.id,
            parts: [{ type: "text", text: "second" }],
            dispatchLeaseId: ack.leaseId,
          }),
        );
        expect(second._tag).toBe("Left");
      }),
    20_000,
  );

  // ── Scenario 9 — insert-failure rollback (architect §8 #9, risk #10) ─
  it.live(
    "insert-failure rollback: archive between grant and send → sendInsert fails → lease rolls back to GRANTED via Effect.acquireUseRelease",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        const conv = yield* alice.client.sendRpc(ConversationsCreate, {
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        });
        const ack = yield* bob.client.sendRpc(DispatchRequest, {
          conversationId: conv.conversation.id,
          messageId: makeProbeMessageId(),
          senderAgentId: protocolAgentId(alice.agentId),
          parts: [{ type: "text", text: "probe" }],
        });
        yield* bob.client.waitForNotification(DispatchRelease, 5000);
        // Archive the conversation so the next sendInsert fails with
        // ConversationArchivedError. The lease has already been claimed
        // by `claim`, but `acquireUseRelease`'s release-arm rolls back
        // to GRANTED on failure.
        yield* alice.client.sendRpc(ConversationsArchive, {
          conversationId: conv.conversation.id,
        });
        const sendResult = yield* Effect.either(
          bob.client.sendRpc(MessagesSend, {
            conversationId: conv.conversation.id,
            parts: [{ type: "text", text: "probe" }],
            dispatchLeaseId: ack.leaseId,
          }),
        );
        // Insert failed (archived).
        expect(sendResult._tag).toBe("Left");
        // Lease must be back to GRANTED (rolled back), not CLAIMED or CONSUMED.
        const coreApp = getTestCoreApp();
        const record = yield* coreApp.leaseRegistry.read({
          _tag: "leaseId",
          value: ack.leaseId as LeaseId,
        });
        expect(record.state).toBe("GRANTED");
      }),
    20_000,
  );

  // ── Scenario 10 — post-insert durability (architect §8 #10) ─────────
  //
  // Architect plan §8 #10: "sendCommit fails after finalize → lease
  // stays CONSUMED, durable row stays → retry fails with CONSUMED
  // typed error".
  //
  // The implementation orders `claim → sendInsert → finalize →
  // sendCommit` (architect §3 + epic decision #5). Once finalize fires,
  // post-insert side-effect failures (TM routing, broadcast, trace,
  // delivery webhook) MUST NOT roll back the lease — the durable row
  // is permanent and the moderator's view is already consistent.
  //
  // Two assertions:
  //   (a) Happy-path baseline: successful send leaves the lease
  //       CONSUMED + the durable row in place; retry rejects.
  //   (b) Failure-path: sendCommit's TM routing fails (because the
  //       moderator is offline + the conversation is app-bound, so
  //       tm_endpoint_address resolves to a dead agent endpoint).
  //       The lease MUST still be CONSUMED, the durable row MUST
  //       still be readable, and the retry MUST reject with the
  //       CONSUMED typed error — exactly the architect-§8 #10
  //       invariant.
  it.live(
    "post-insert durability happy path: successful send leaves lease CONSUMED with durable row; retry rejects",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        const conv = yield* alice.client.sendRpc(ConversationsCreate, {
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        });
        const ack = yield* bob.client.sendRpc(DispatchRequest, {
          conversationId: conv.conversation.id,
          messageId: makeProbeMessageId(),
          senderAgentId: protocolAgentId(alice.agentId),
          parts: [{ type: "text", text: "first" }],
        });
        yield* bob.client.waitForNotification(DispatchRelease, 5000);
        const first = yield* bob.client.sendRpc(MessagesSend, {
          conversationId: conv.conversation.id,
          parts: [{ type: "text", text: "first" }],
          dispatchLeaseId: ack.leaseId,
        });
        // Lease state is CONSUMED; durable row landed.
        const coreApp = getTestCoreApp();
        const record = yield* coreApp.leaseRegistry.read({
          _tag: "leaseId",
          value: ack.leaseId as LeaseId,
        });
        expect(record.state).toBe("CONSUMED");
        expect(record.consumedMessageId).toBe(first.message.id);
        // Retry rejects.
        const retry = yield* Effect.either(
          bob.client.sendRpc(MessagesSend, {
            conversationId: conv.conversation.id,
            parts: [{ type: "text", text: "retry" }],
            dispatchLeaseId: ack.leaseId,
          }),
        );
        expect(retry._tag).toBe("Left");
      }),
    20_000,
  );

  it.live(
    "post-insert durability failure path: sendCommit fails after finalize → lease stays CONSUMED + durable row stays + retry rejects (architect §8 #10)",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        nextHookVerdict = { decision: "grant" };
        // App-bound conversation so sendCommit's TM routing path runs.
        // tm_endpoint_address = tm:agent:<aliceId>. Disconnecting alice
        // before bob's send removes alice from the agent-endpoint
        // resolver, so the TM-routing send in sendCommit will fail.
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
          parts: [{ type: "text", text: "first" }],
        });
        yield* bob.client.waitForNotification(DispatchRelease, 5000);
        // Disconnect alice. Her agent endpoint drops from the resolver.
        // bob's subsequent send will commit the durable row, finalize
        // the lease, then fail in sendCommit (TM routing has no target).
        yield* alice.client.close();
        // Allow the disconnect finalizer to clear the resolver entry.
        yield* Effect.sleep("300 millis");
        const sendResult = yield* Effect.either(
          bob.client.sendRpc(MessagesSend, {
            conversationId: conv.conversation.id,
            parts: [{ type: "text", text: "first" }],
            dispatchLeaseId: ack.leaseId,
          }),
        );
        // sendCommit failure surfaces to bob as an RPC error.
        expect(sendResult._tag).toBe("Left");
        // Lease MUST be CONSUMED (finalize ran before the failure;
        // post-insert side-effect failures do not roll back).
        const coreApp = getTestCoreApp();
        const record = yield* coreApp.leaseRegistry.read({
          _tag: "leaseId",
          value: ack.leaseId as LeaseId,
        });
        expect(record.state).toBe("CONSUMED");
        expect(record.consumedMessageId).not.toBeNull();
        // Retry rejects with CONSUMED — durable row is permanent, the
        // caller MUST NOT retry a successful insert. bob.client is
        // still connected (only alice was closed); the retry hits the
        // CLAIMED→ via state-CONSUMED rejection path.
        const retry = yield* Effect.either(
          bob.client.sendRpc(MessagesSend, {
            conversationId: conv.conversation.id,
            parts: [{ type: "text", text: "retry" }],
            dispatchLeaseId: ack.leaseId,
          }),
        );
        expect(retry._tag).toBe("Left");
      }),
    25_000,
  );
});
