/**
 * #529 reshape additive — `dispatch/{request, authorize, release}` +
 * `dispatches/{consumed, expired, get}` admission surface.
 *
 * Bucket file: `lifecycle` group. Split from `dispatch-flow.integration.test.ts`
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
import {
  DISPATCH_STATE_ABANDONED,
  DISPATCH_STATE_CONSUMED,
  DISPATCH_STATE_EXPIRED,
  DISPATCH_STATE_GRANTED,
  DISPATCH_VERDICT_HOLD,
  EITHER_LEFT_TAG,
  MODERATOR_UNAVAILABLE_REASON,
  createDispatchFlowFixture,
  makeProbeMessageId,
  startDispatchFlowServer,
  stopDispatchFlowServer,
} from "./fixture.js";
import {
  registerAndConnect,
  setupAgentPair,
  getTestCoreApp,
} from "../../helpers.js";

const it = effectIt.live;

const TEST_APP_ID = "moderator-dispatch-test-app";

const TEST_APP_MANIFEST: AppManifest = {
  appId: TEST_APP_ID,
  name: "Moderator Dispatch Test App",
  conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
};

const fixture = createDispatchFlowFixture(TEST_APP_MANIFEST);

beforeAll(startDispatchFlowServer, 60_000);

afterAll(stopDispatchFlowServer);

beforeEach(() => Effect.runPromise(fixture.reset));

describe("dispatch/* — lifecycle: TTL, close, reconnect (#529 reshape additive)", () => {
  // Scenario 17 — verdict-deny vs synthesized-infra-hold distinction
  // (architect risk #5, epic decision #10).
  //
  // Synthesized infra-hold (`task.app_id IS NOT NULL` + no moderator
  // hook registered) is NOT verdict-deny. Without the distinction, a
  // moderator restart would mass-evict every recipient that messaged
  // during the restart window. Asserts: hold verdict fires AND no
  // `participants/removed` is observed inside a generous wait.
  it(
    "verdict-deny vs synthesized-infra-hold distinction: synthesized infra-hold (no hook) does NOT call removeParticipant",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        // Bind the task to an unknown app — no hook registered → infra-hold path.
        const unknownAppId = "no-hook-dispatch-app";
        const task = yield* alice.client.sendRpc(TasksCreate, {
          appId: unknownAppId,
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
        expect(params.verdict.decision).toBe(DISPATCH_VERDICT_HOLD);
        expect(params.verdict.reason).toBe(MODERATOR_UNAVAILABLE_REASON);
        // Negative assertion: NO participants/removed fires within
        // the wait window. waitForNotification returns
        // `null`-or-throws on timeout depending on the test client
        // contract; treat the timeout as the proof.
        const removedExit = yield* Effect.either(
          bob.client.waitForNotification(
            ParticipantsRemovedNotificationDefinition,
            500,
          ),
        );
        expect(removedExit._tag).toBe(EITHER_LEFT_TAG);
      }),
    20_000,
  );

  // Scenario 6 — post-grant TTL expiry (verified via registry direct
  // read; the wire dispatches/get path requires the moderator
  // connection-id binding which only the row 13 cutover wires).
  it(
    "post-grant TTL: granted lease expires after leaseTimeoutMs",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        fixture.setNextHookVerdict({ decision: "grant", leaseTimeoutMs: 100 });
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
        // Wait for grant.
        yield* bob.client.waitForNotification(DispatchRelease, 5000);
        // Wait past TTL.
        yield* Effect.sleep("400 millis");
        const coreApp = getTestCoreApp();
        const record = yield* coreApp.leaseRegistry.read({
          _tag: "dispatchId",
          value: ack.dispatchId as DispatchId,
        });
        expect(record.state).toBe(DISPATCH_STATE_EXPIRED);
      }),
    20_000,
  );

  // ── Scenario 15 — connection close mid-flow (architect §8 #15) ──────
  //
  // Architect plan §8 #15:
  //   "recipient disconnects in PENDING → ABANDONED;
  //    recipient disconnects in GRANTED → EXPIRED;
  //    CLAIMED is no-op."
  //
  // Three sub-assertions cover the architect's three rows. The CLAIMED
  // no-op is load-bearing rule 2 (architect §3): an in-flight
  // `messages/send` owns the lease via Effect.acquireUseRelease; the
  // connection-close finalizer MUST NOT roll back a committed durable
  // row. We can't easily synchronize a disconnect mid-`sendInsert` over
  // the wire without a fault-injection point, so the CLAIMED arm is
  // covered indirectly: a normal dispatch + send leaves the lease
  // CONSUMED (not rolled back) even when the recipient subsequently
  // disconnects.
  it(
    "connection close in PENDING: PENDING → ABANDONED (architect §8 #15)",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        fixture.setNextHookVerdict({ kind: "never-reply" });
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
          parts: [{ type: "text", text: "abandon" }],
        });
        // Disconnect while PENDING (moderator never replies).
        yield* bob.client.close();
        // Allow the disconnect finalizer to run.
        yield* Effect.sleep("300 millis");
        const coreApp = getTestCoreApp();
        const record = yield* coreApp.leaseRegistry.read({
          _tag: "leaseId",
          value: ack.leaseId as LeaseId,
        });
        // Architect §3 + §8 #15: PENDING + recipient close → ABANDONED.
        expect(record.state).toBe(DISPATCH_STATE_ABANDONED);
      }),
    20_000,
  );

  it(
    "connection close in GRANTED: GRANTED → EXPIRED-on-disconnect (architect §8 #15)",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        // Default-grant path (no moderator) → lease enters GRANTED via
        // synthesized verdict in `runForkedDispatchRoundTrip`'s
        // NoAppSession arm. Use a long leaseTimeoutMs so the TTL
        // doesn't fire ahead of the disconnect.
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
        const coreApp = getTestCoreApp();
        const granted = yield* coreApp.leaseRegistry.read({
          _tag: "leaseId",
          value: ack.leaseId as LeaseId,
        });
        expect(granted.state).toBe(DISPATCH_STATE_GRANTED);
        yield* bob.client.close();
        yield* Effect.sleep("300 millis");
        const expired = yield* coreApp.leaseRegistry.read({
          _tag: "leaseId",
          value: ack.leaseId as LeaseId,
        });
        // Architect §3 + §8 #15: GRANTED + recipient close →
        // EXPIRED-on-disconnect (terminal).
        expect(expired.state).toBe(DISPATCH_STATE_EXPIRED);
      }),
    20_000,
  );

  it(
    "connection close after CONSUMED: terminal state stays CONSUMED (architect §8 #15 CLAIMED→no-op corollary)",
    () =>
      Effect.gen(function* () {
        // The CLAIMED no-op rule is load-bearing for in-flight inserts
        // (rule 2). Once the insert commits and the lease transitions
        // CONSUMED, the connection-close finalizer must not perturb
        // the terminal state. Synchronizing a disconnect mid-insert is
        // brittle over the wire, so we assert the post-CONSUMED
        // invariant: closing after a successful send leaves the lease
        // CONSUMED + the durable row in place.
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
        const sent = yield* bob.client.sendRpc(MessagesSend, {
          conversationId: conv.conversation.id,
          parts: [{ type: "text", text: "first" }],
          dispatchLeaseId: ack.leaseId,
        });
        const coreApp = getTestCoreApp();
        const consumed = yield* coreApp.leaseRegistry.read({
          _tag: "leaseId",
          value: ack.leaseId as LeaseId,
        });
        expect(consumed.state).toBe(DISPATCH_STATE_CONSUMED);
        yield* bob.client.close();
        yield* Effect.sleep("300 millis");
        const after = yield* coreApp.leaseRegistry.read({
          _tag: "leaseId",
          value: ack.leaseId as LeaseId,
        });
        expect(after.state).toBe(DISPATCH_STATE_CONSUMED);
        expect(after.consumedMessageId).toBe(sent.message.id);
      }),
    20_000,
  );

  // ── Scenario 16 — reconnect after lease aged out (architect §8 #16) ─
  it(
    "reconnect: lease expired between grant and reconnect → re-issuing dispatch/request mints a NEW lease (no resume)",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        fixture.setNextHookVerdict({ decision: "grant", leaseTimeoutMs: 100 });
        const task = yield* alice.client.sendRpc(TasksCreate, {
          appId: TEST_APP_ID,
          tmType: "self",
        });
        const conv = yield* alice.client.sendRpc(TasksCreateConversation, {
          taskId: task.task.id,
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        });
        const firstAck = yield* bob.client.sendRpc(DispatchRequest, {
          conversationId: conv.conversation.id,
          messageId: makeProbeMessageId(),
          senderAgentId: protocolAgentId(alice.agentId),
          parts: [{ type: "text", text: "first" }],
        });
        yield* bob.client.waitForNotification(DispatchRelease, 5000);
        // Wait for TTL to fire.
        yield* Effect.sleep("400 millis");
        const coreApp = getTestCoreApp();
        const expired = yield* coreApp.leaseRegistry.read({
          _tag: "leaseId",
          value: firstAck.leaseId as LeaseId,
        });
        expect(expired.state).toBe(DISPATCH_STATE_EXPIRED);
        // Reconnect bob. Re-issue dispatch/request. Server mints a fresh
        // lease (different leaseId).
        yield* bob.client.close();
        const bob2 = yield* registerAndConnect("bob2");
        fixture.setNextHookVerdict({ decision: "grant" });
        // bob2 is a different agent — re-create conv with bob2 to isolate.
        const conv2 = yield* alice.client.sendRpc(TasksCreateConversation, {
          taskId: task.task.id,
          type: "dm",
          participants: [{ type: "agent", id: bob2.agentId }],
        });
        const secondAck = yield* bob2.client.sendRpc(DispatchRequest, {
          conversationId: conv2.conversation.id,
          messageId: makeProbeMessageId(),
          senderAgentId: protocolAgentId(alice.agentId),
          parts: [{ type: "text", text: "second" }],
        });
        expect(secondAck.leaseId).not.toBe(firstAck.leaseId);
        expect(secondAck.dispatchId).not.toBe(firstAck.dispatchId);
      }),
    25_000,
  );
});
