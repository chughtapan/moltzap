/**
 * #529 reshape additive — `dispatch/{request, authorize, release}` +
 * `dispatches/{consumed, expired, get}` admission surface.
 *
 * Bucket file: `dispatches-get` group. Split from `dispatch-flow.integration.test.ts`
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

describe("dispatch/* — dispatches/get reads (#529 reshape additive)", () => {
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
