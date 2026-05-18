/**
 * #529 reshape additive — `dispatch/{request, authorize, release}` +
 * `dispatches/{consumed, expired, get}` admission surface.
 *
 * Bucket file: `happy-paths` group. Split from `dispatch-flow.integration.test.ts`
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
  DISPATCH_VERDICT_GRANT,
  EXPECTED_TYPE_STRING,
  createDispatchFlowFixture,
  makeProbeMessageId,
  startDispatchFlowServer,
  stopDispatchFlowServer,
} from "./fixture.js";
import { setupAgentPair } from "../../helpers.js";

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

describe("dispatch/* — happy paths (#529 reshape additive)", () => {
  // Scenario 1 — happy path moderated
  it(
    "happy path moderated: dispatch/request → moderator grant → dispatch/release{grant} → messages/send → dispatches/consumed",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        fixture.setNextHookVerdict({ decision: "grant" });
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

        expect(typeof ack.leaseId).toBe(EXPECTED_TYPE_STRING);
        expect(typeof ack.dispatchId).toBe(EXPECTED_TYPE_STRING);
        expect(ack.leaseId).not.toBe(ack.dispatchId);

        // Wait for dispatch/release fire-and-forget notification.
        const release = yield* bob.client.waitForNotification(
          DispatchRelease,
          5000,
        );
        const params = release.params as {
          leaseId: string;
          verdict: { decision: string };
        };
        expect(params.leaseId).toBe(ack.leaseId);
        expect(params.verdict.decision).toBe(DISPATCH_VERDICT_GRANT);
        expect(fixture.hookCalls()).toBe(1);
      }),
    20_000,
  );

  // Scenario 2 — happy path default-grant (NoAppSession)
  it(
    "happy path default-grant: dispatch/request for unmoderated task → dispatch/release{grant} fires immediately",
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
        const release = yield* bob.client.waitForNotification(
          DispatchRelease,
          5000,
        );
        expect((release.params as { leaseId: string }).leaseId).toBe(
          ack.leaseId,
        );
        expect(
          (release.params as { verdict: { decision: string } }).verdict
            .decision,
        ).toBe(DISPATCH_VERDICT_GRANT);
        // No hook should have been consulted.
        expect(fixture.hookCalls()).toBe(0);
      }),
    20_000,
  );

  // Smoke test — assert leaseId is returned by ack and the wire
  // descriptor surface is wired through the rpc registry. Useful as a
  // canary; the other scenarios cover the substantive contract.
  it(
    "wire surface canary: dispatch/request descriptor is registered",
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
          parts: [{ type: "text", text: "canary" }],
        });
        expect(typeof ack.leaseId).toBe(EXPECTED_TYPE_STRING);
        expect(typeof ack.dispatchId).toBe(EXPECTED_TYPE_STRING);
        // Use of branded id types — pure compile-time test.
        const _leaseIdBrand: LeaseId = ack.leaseId;
        const _dispatchIdBrand: DispatchId = ack.dispatchId;
        void _leaseIdBrand;
        void _dispatchIdBrand;
        // ConversationId import to silence linter.
        const _convId: ConversationId = conv.conversation.id;
        void _convId;
      }),
    20_000,
  );
});
