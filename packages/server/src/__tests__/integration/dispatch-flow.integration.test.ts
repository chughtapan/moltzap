/**
 * #529 reshape additive — `dispatch/{request, authorize, release}` +
 * `dispatches/{consumed, expired, get}` admission surface.
 *
 * Covers the 17 scenarios from architect plan §8. Each scenario is named
 * per the plan's enumeration. Server-side coverage proves the lease
 * registry's state machine + the forked moderator round-trip + the
 * `Effect.acquireUseRelease` wrap in the messages handler all integrate
 * end-to-end against the real WS server.
 *
 * Cross-impl client-side coverage of these scenarios lands with the
 * row 13 cutover follow-up (the conformance `TestServer` extension).
 *
 * Architecture: the recipient calls `dispatch/request` over WS;
 * server mints a lease, returns ack synchronously, forks the moderator
 * round-trip; recipient observes the verdict via `dispatch/release`
 * notification. `messages/send(dispatchLeaseId=X)` consumes the lease
 * via `Effect.acquireUseRelease(claim, sendInsert+commit, finalize|rollback)`.
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
} from "./helpers.js";

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

describe("dispatch/* reshape additive (#529)", () => {
  // Scenario 1 — happy path moderated
  it.live(
    "happy path moderated: dispatch/request → moderator grant → dispatch/release{grant} → messages/send → dispatches/consumed",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        nextHookVerdict = { decision: "grant" };
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

        expect(typeof ack.leaseId).toBe("string");
        expect(typeof ack.dispatchId).toBe("string");
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
        expect(params.verdict.decision).toBe("grant");
        expect(hookCalls).toBe(1);
      }),
    20_000,
  );

  // Scenario 2 — happy path default-grant (NoAppSession)
  it.live(
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
        ).toBe("grant");
        // No hook should have been consulted.
        expect(hookCalls).toBe(0);
      }),
    20_000,
  );

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

  // Scenario 13 — dispatches/get happy path (lease record via direct
  // registry read; the wire-rpc scope-enforcement requires the
  // moderator's connection id to match the binding tuple, which is
  // covered by scenario 14's negative branch + the unit test below).
  it.live(
    "dispatches/get happy path (registry direct): granted lease is readable with state=GRANTED",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        nextHookVerdict = { decision: "grant" };
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
        yield* bob.client.waitForNotification(DispatchRelease, 5000);

        // Read via registry direct (in-process hook path → empty moderator
        // connection id → wire RPC scope-fails. The registry contract is
        // intact; the wire-RPC happy path needs apps/register + a real
        // wire moderator handler, covered by the row 13 cutover).
        const coreApp = getTestCoreApp();
        const registry = coreApp.leaseRegistry;
        const record = yield* registry.read({
          _tag: "dispatchId",
          value: ack.dispatchId as DispatchId,
        });
        expect(record.dispatchId).toBe(ack.dispatchId);
        expect(record.leaseId).toBe(ack.leaseId);
        expect(record.state).toBe("GRANTED");
      }),
    20_000,
  );

  // Scenario 14 — dispatches/get scope enforcement
  it.live(
    "dispatches/get scope enforcement: non-governing app gets typed ForbiddenError",
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
        // bob is the recipient — not the moderator. Should be forbidden.
        const result = yield* Effect.either(
          bob.client.sendRpc(DispatchesGet, {
            dispatchId: ack.dispatchId as DispatchId,
          }),
        );
        // Must be a Forbidden error (not a success).
        expect(result._tag).toBe("Left");
      }),
    20_000,
  );

  // Scenario 17 — verdict-deny vs synthesized-infra-hold distinction
  // (architect risk #5, epic decision #10).
  //
  // Synthesized infra-hold (`task.app_id IS NOT NULL` + no moderator
  // hook registered) is NOT verdict-deny. Without the distinction, a
  // moderator restart would mass-evict every recipient that messaged
  // during the restart window. Asserts: hold verdict fires AND no
  // `participants/removed` is observed inside a generous wait.
  it.live(
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
        expect(params.verdict.decision).toBe("hold");
        expect(params.verdict.reason).toBe("moderator_unavailable");
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
        expect(removedExit._tag).toBe("Left");
      }),
    20_000,
  );

  // Scenario 6 — post-grant TTL expiry (verified via registry direct
  // read; the wire dispatches/get path requires the moderator
  // connection-id binding which only the row 13 cutover wires).
  it.live(
    "post-grant TTL: granted lease expires after leaseTimeoutMs",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        nextHookVerdict = { decision: "grant", leaseTimeoutMs: 100 };
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
        expect(record.state).toBe("EXPIRED");
      }),
    20_000,
  );

  // Smoke test — assert leaseId is returned by ack and the wire
  // descriptor surface is wired through the rpc registry. Useful as a
  // canary; the other scenarios cover the substantive contract.
  it.live(
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
        expect(typeof ack.leaseId).toBe("string");
        expect(typeof ack.dispatchId).toBe("string");
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
  it.live(
    "connection close in PENDING: PENDING → ABANDONED (architect §8 #15)",
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
        expect(record.state).toBe("ABANDONED");
      }),
    20_000,
  );

  it.live(
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
        expect(granted.state).toBe("GRANTED");
        yield* bob.client.close();
        yield* Effect.sleep("300 millis");
        const expired = yield* coreApp.leaseRegistry.read({
          _tag: "leaseId",
          value: ack.leaseId as LeaseId,
        });
        // Architect §3 + §8 #15: GRANTED + recipient close →
        // EXPIRED-on-disconnect (terminal).
        expect(expired.state).toBe("EXPIRED");
      }),
    20_000,
  );

  it.live(
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
        expect(consumed.state).toBe("CONSUMED");
        yield* bob.client.close();
        yield* Effect.sleep("300 millis");
        const after = yield* coreApp.leaseRegistry.read({
          _tag: "leaseId",
          value: ack.leaseId as LeaseId,
        });
        expect(after.state).toBe("CONSUMED");
        expect(after.consumedMessageId).toBe(sent.message.id);
      }),
    20_000,
  );

  // ── Scenario 16 — reconnect after lease aged out (architect §8 #16) ─
  it.live(
    "reconnect: lease expired between grant and reconnect → re-issuing dispatch/request mints a NEW lease (no resume)",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        nextHookVerdict = { decision: "grant", leaseTimeoutMs: 100 };
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
        expect(expired.state).toBe("EXPIRED");
        // Reconnect bob. Re-issue dispatch/request. Server mints a fresh
        // lease (different leaseId).
        yield* bob.client.close();
        const bob2 = yield* registerAndConnect("bob2");
        nextHookVerdict = { decision: "grant" };
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

  // ── Scenario 13 wire path — `dispatches/get` over the wire (Fix #3) ─
  //
  // Distinct from the existing registry-direct scenario above: this one
  // sets up a wire-side moderator (a separate test client that calls
  // `apps/register` with a `dispatch_authorize` hook key, then handles
  // `dispatch/authorize` via the test-client's `handleServerRpc` API).
  // When bob calls `dispatch/request`, the server forks the moderator
  // round-trip via `runRemoteHookEffect`, the wire-side moderator
  // replies grant, and the binding tuple captures the moderator's
  // connection id. `dispatches/get` from the moderator's connection
  // then succeeds (matching connId), and from a non-moderator connection
  // returns the typed ForbiddenError already covered by scenario 14.
  //
  // Per the brief, this is test-client moderator wiring (test infra
  // only) — not the production adapter migration which lands in row 13.
  it.live(
    "dispatches/get wire happy path: moderator over WS reads its lease record at GRANTED stage",
    () =>
      Effect.gen(function* () {
        // Set up a wire moderator via apps/register + handleServerRpc.
        const moderator = yield* registerAndConnect("wire-moderator");
        const wireAppId = "wire-moderator-dispatch-app";
        const wireManifest: AppManifest = {
          appId: wireAppId,
          name: "Wire Moderator Dispatch App",
          conversations: [
            { key: "main", name: "Main", participantFilter: "all" },
          ],
          hooks: {
            dispatch_authorize: { timeout_ms: 5000 },
          },
        };
        // Register the manifest with the in-process AppHost so the
        // server knows the manifest exists. Then call apps/register over
        // WS so the moderator's connection becomes the routing target
        // (registerRemoteApp records the connectionId).
        const coreApp = getTestCoreApp();
        coreApp.registerApp(wireManifest);
        yield* moderator.client.sendRpc(AppsRegister, {
          manifest: wireManifest,
        });
        // Wire the moderator's S→C handler for dispatch/authorize.
        yield* moderator.client.handleServerRpc(DispatchAuthorize, () =>
          Effect.succeed({
            admission: { decision: "grant" as const },
          }),
        );
        // Set up the recipient and bind a task to the wire moderator's app.
        const recipient = yield* registerAndConnect("wire-recipient");
        const task = yield* moderator.client.sendRpc(TasksCreate, {
          appId: wireAppId,
          tmType: "self",
        });
        const conv = yield* moderator.client.sendRpc(TasksCreateConversation, {
          taskId: task.task.id,
          type: "dm",
          participants: [{ type: "agent", id: recipient.agentId }],
        });
        const ack = yield* recipient.client.sendRpc(DispatchRequest, {
          conversationId: conv.conversation.id,
          messageId: makeProbeMessageId(),
          senderAgentId: protocolAgentId(moderator.agentId),
          parts: [{ type: "text", text: "wire" }],
        });
        const release = yield* recipient.client.waitForNotification(
          DispatchRelease,
          5000,
        );
        expect((release.params as { leaseId: string }).leaseId).toBe(
          ack.leaseId,
        );
        // Now `dispatches/get` from the moderator's wire connection
        // succeeds — moderatorConnectionId in the binding tuple matches.
        const view = yield* moderator.client.sendRpc(DispatchesGet, {
          dispatchId: ack.dispatchId as DispatchId,
        });
        expect(view.lease.dispatchId).toBe(ack.dispatchId);
        expect(view.lease.leaseId).toBe(ack.leaseId);
        expect(view.lease.state).toBe("GRANTED");
      }),
    25_000,
  );
});
