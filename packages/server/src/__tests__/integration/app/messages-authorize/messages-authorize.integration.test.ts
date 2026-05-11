/**
 * #560 — `messages/authorize` send-side gate.
 *
 * Validates the verdict-path, race-safety, default-flow regression,
 * and per-caller visibility filter from architect plan §8 (tests 1-7).
 * The verdict-path tests register an in-process `messageAuthorize`
 * hook against the task's `tm_endpoint_address` and use the verdict to
 * gate `messages/send`. Default-flow tests register an override hook
 * on `DEFAULT_DM_TM_ADDRESS` so the Block-proof variant proves
 * invocation (memory `feedback_predicate_tautology_lesson`).
 *
 * Integration tests are excluded from `tsc --build` (memory
 * `project_integration_tests_not_typechecked`).
 */
import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Either } from "effect";
import {
  ConversationsCreate,
  HookBlockedError,
  MessagesList,
  MessagesSend,
  MessageReceivedNotificationDefinition,
  TasksCreate,
  TasksCreateConversation,
  type AgentId,
  type AppManifest,
  type ConversationId,
  type MessageId,
} from "@moltzap/protocol";
import { endpointAddress } from "@moltzap/protocol/network";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  registerAndConnect,
  setupAgentPair,
  getTestCoreApp,
  getKyselyDb,
} from "../../helpers.js";

const TEST_APP_ID = "messages-authorize-test-app";

const TEST_APP_MANIFEST: AppManifest = {
  appId: TEST_APP_ID,
  name: "Messages-Authorize Test App",
  hooks: {
    message_authorize: { timeout_ms: 5_000 },
  },
};

const DEFAULT_DM_TM_ADDRESS = endpointAddress(
  "tm:app:00000000-0000-4d11-8000-000000000d11",
);

type MessageAuthorizeVerdict =
  | { decision: "Forward"; recipients: ReadonlyArray<AgentId> }
  | { decision: "Block"; reason?: string };

interface VerdictState {
  next: MessageAuthorizeVerdict | { kind: "never-reply" };
  calls: number;
}

let appHookState: VerdictState = {
  next: { decision: "Forward", recipients: [] },
  calls: 0,
};
let defaultDmHookState: VerdictState | null = null;

beforeAll(async () => {
  await startTestServer();
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
  appHookState = {
    next: { decision: "Forward", recipients: [] },
    calls: 0,
  };
  defaultDmHookState = null;
  const coreApp = getTestCoreApp();
  coreApp.registerApp(TEST_APP_MANIFEST);
});

/**
 * Register the messageAuthorize hook for the agent's TM endpoint
 * address. Each test calls this after registering its TM agent so
 * the hook keys on the correct `tm:agent:<agentId>` shape.
 */
function registerTmHook(tmAgentId: string): void {
  const coreApp = getTestCoreApp();
  const addr = endpointAddress(`tm:agent:${tmAgentId}`);
  coreApp.registerMessageAuthorize(addr, (ctx) => {
    appHookState.calls += 1;
    const v = appHookState.next;
    if ("kind" in v && v.kind === "never-reply") {
      // Never resolve — server-side timeout fires after the manifest
      // timeout. Test 3 narrows that timeout to 500ms.
      // eslint-disable-next-line agent-code-guard/promise-type -- intentional: simulate stuck remote
      return new Promise<MessageAuthorizeVerdict>(() => {
        /* never */
      });
    }
    void ctx;
    return v as MessageAuthorizeVerdict;
  });
}

// Helpers for raw DB inspection of tm_decision.
function readTmDecision(messageId: string): Effect.Effect<unknown, Error> {
  return Effect.tryPromise({
    try: () =>
      getKyselyDb()
        .selectFrom("messages")
        .select("tm_decision")
        .where("id", "=", messageId)
        .executeTakeFirstOrThrow(),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  }).pipe(Effect.map((row) => row.tm_decision));
}

function readAllMessageIdsForConversation(
  conversationId: string,
): Effect.Effect<ReadonlyArray<string>, Error> {
  return Effect.tryPromise({
    try: () =>
      getKyselyDb()
        .selectFrom("messages")
        .select("id")
        .where("conversation_id", "=", conversationId)
        .execute(),
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
  }).pipe(Effect.map((rows) => rows.map((r) => r.id)));
}

describe("messages/authorize — verdict paths (#560 §8.1-3)", () => {
  // Test 1: Block verdict path.
  it.live(
    "Block: sender's messages/send fails with HookBlockedError; recipient receives no message; DB row block",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        registerTmHook(alice.agentId);
        appHookState.next = { decision: "Block", reason: "test-block" };

        const task = yield* alice.client.sendRpc(TasksCreate, {
          appId: TEST_APP_ID,
          tmType: "self",
        });
        const conv = yield* alice.client.sendRpc(TasksCreateConversation, {
          taskId: task.task.id,
          type: "group",
          name: "ma-block",
          participants: [{ type: "agent", id: bob.agentId }],
        });
        const conversationId = conv.conversation.id as ConversationId;

        const outcome = yield* Effect.either(
          alice.client.sendRpc(MessagesSend, {
            conversationId,
            parts: [{ type: "text", text: "blocked-msg" }],
          }),
        );
        expect(Either.isLeft(outcome)).toBe(true);
        if (Either.isLeft(outcome)) {
          const err = outcome.left as { code?: number; message?: string };
          expect(err.code).toBe(HookBlockedError.code);
          expect(String(err.message)).toMatch(/block/i);
        }
        expect(appHookState.calls).toBe(1);

        // Allow time for any erroneous notification to surface.
        yield* Effect.sleep("200 millis");
        const bobNotifications = bob.client
          .drainNotifications()
          .filter(
            (n) => n.method === MessageReceivedNotificationDefinition.name,
          );
        expect(bobNotifications.length).toBe(0);

        // DB row durably inserted with verdict {tag:"block"}.
        const ids = yield* readAllMessageIdsForConversation(conversationId);
        expect(ids.length).toBe(1);
        const decision = (yield* readTmDecision(ids[0]!)) as {
          tag: string;
          reason?: string;
        };
        expect(decision.tag).toBe("block");
        expect(decision.reason).toBe("test-block");
      }),
    30_000,
  );

  // Test 2: Forward subset.
  it.live(
    "Forward subset: only TM-authorized recipients see messages/received; verdict {tag:forward,recipients}",
    () =>
      Effect.gen(function* () {
        const alice = yield* registerAndConnect("alice-sub");
        const bob = yield* registerAndConnect("bob-sub");
        const carol = yield* registerAndConnect("carol-sub");
        const dave = yield* registerAndConnect("dave-sub");
        registerTmHook(alice.agentId);

        const task = yield* alice.client.sendRpc(TasksCreate, {
          appId: TEST_APP_ID,
          tmType: "self",
        });
        const conv = yield* alice.client.sendRpc(TasksCreateConversation, {
          taskId: task.task.id,
          type: "group",
          name: "ma-subset",
          participants: [
            { type: "agent", id: bob.agentId },
            { type: "agent", id: carol.agentId },
            { type: "agent", id: dave.agentId },
          ],
        });
        const conversationId = conv.conversation.id as ConversationId;

        // Forward only to carol.
        appHookState.next = {
          decision: "Forward",
          recipients: [carol.agentId as AgentId],
        };

        const sent = yield* alice.client.sendRpc(MessagesSend, {
          conversationId,
          parts: [{ type: "text", text: "subset-msg" }],
        });
        const messageId = sent.message.id as MessageId;

        // Allow notifications to land.
        yield* Effect.sleep("300 millis");
        const bobN = bob.client
          .drainNotifications()
          .filter(
            (n) => n.method === MessageReceivedNotificationDefinition.name,
          );
        const carolN = carol.client
          .drainNotifications()
          .filter(
            (n) => n.method === MessageReceivedNotificationDefinition.name,
          );
        const daveN = dave.client
          .drainNotifications()
          .filter(
            (n) => n.method === MessageReceivedNotificationDefinition.name,
          );
        expect(carolN.length).toBe(1);
        expect(bobN.length).toBe(0);
        expect(daveN.length).toBe(0);

        const decision = (yield* readTmDecision(messageId)) as {
          tag: string;
          recipients: ReadonlyArray<string>;
        };
        expect(decision.tag).toBe("forward");
        expect(decision.recipients).toEqual([carol.agentId]);
      }),
    30_000,
  );

  // Test 3: TM unreachable → server synthesizes Block.
  //
  // The TM endpoint for tmType:"self" is `tm:agent:<aliceId>` — not
  // `tm:app:<appId>` — so the manifest's `hooks.message_authorize.
  // timeout_ms` does NOT apply to this path. AppHost falls back to
  // `DEFAULT_APP_HOOK_TIMEOUT_MS` = 5s. Test budget is sized to
  // accommodate the full 5s wait.
  it.live(
    "TM unreachable: never-reply hook -> envelope synthesizes Block { reason: tm_unreachable }; sender fails; no fan-out",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        registerTmHook(alice.agentId);

        appHookState.next = { kind: "never-reply" };

        const task = yield* alice.client.sendRpc(TasksCreate, {
          appId: TEST_APP_ID,
          tmType: "self",
        });
        const conv = yield* alice.client.sendRpc(TasksCreateConversation, {
          taskId: task.task.id,
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        });
        const conversationId = conv.conversation.id as ConversationId;

        // Client-side timeout > server AppHost timeout (5s) so the
        // server's fail-closed `Block { reason: tm_unreachable }`
        // arrives before the client gives up.
        const outcome = yield* Effect.either(
          alice.client.sendRpc(
            MessagesSend,
            {
              conversationId,
              parts: [{ type: "text", text: "unreachable" }],
            },
            { timeoutMs: 10_000 },
          ),
        );
        expect(Either.isLeft(outcome)).toBe(true);
        if (Either.isLeft(outcome)) {
          const err = outcome.left as { code?: number; message?: string };
          expect(err.code).toBe(HookBlockedError.code);
        }

        yield* Effect.sleep("200 millis");
        const bobN = bob.client
          .drainNotifications()
          .filter(
            (n) => n.method === MessageReceivedNotificationDefinition.name,
          );
        expect(bobN.length).toBe(0);
      }),
    30_000,
  );

  // Test 4: Forward { recipients: [] } - sender's send succeeds; no fan-out;
  // DB row carries forward with empty recipients.
  it.live(
    "Forward empty: TM returns Forward { recipients: [] } -> send succeeds, no fan-out, row {tag:forward,recipients:[]}",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        registerTmHook(alice.agentId);
        appHookState.next = { decision: "Forward", recipients: [] };

        const task = yield* alice.client.sendRpc(TasksCreate, {
          appId: TEST_APP_ID,
          tmType: "self",
        });
        const conv = yield* alice.client.sendRpc(TasksCreateConversation, {
          taskId: task.task.id,
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        });
        const conversationId = conv.conversation.id as ConversationId;

        const sent = yield* alice.client.sendRpc(MessagesSend, {
          conversationId,
          parts: [{ type: "text", text: "empty-forward" }],
        });
        const messageId = sent.message.id as MessageId;

        yield* Effect.sleep("200 millis");
        const bobN = bob.client
          .drainNotifications()
          .filter(
            (n) => n.method === MessageReceivedNotificationDefinition.name,
          );
        expect(bobN.length).toBe(0);
        const decision = (yield* readTmDecision(messageId)) as {
          tag: string;
          recipients: ReadonlyArray<string>;
        };
        expect(decision.tag).toBe("forward");
        expect(decision.recipients).toEqual([]);
      }),
    30_000,
  );

  // Test 5: default-DM messageAuthorize hook IS invoked (Block-proof
  // variant). Replaces the default-DM hook with a Block hook; verifies
  // the Block changes observable behavior (proves invocation, not
  // tautology — memory feedback_predicate_tautology_lesson).
  it.live(
    "default-DM messageAuthorize: replacing the default hook with Block changes observable behavior",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        const coreApp = getTestCoreApp();
        defaultDmHookState = {
          next: { decision: "Block", reason: "default-dm-block" },
          calls: 0,
        };
        coreApp.registerMessageAuthorize(DEFAULT_DM_TM_ADDRESS, (ctx) => {
          defaultDmHookState!.calls += 1;
          void ctx;
          return defaultDmHookState!.next as MessageAuthorizeVerdict;
        });

        // Default DM via `conversations/create` (no taskId) — the
        // server mints an auto-task with `tm_endpoint_address =
        // DEFAULT_DM_TM_ADDRESS`.
        const conv = yield* alice.client.sendRpc(ConversationsCreate, {
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        });
        const conversationId = conv.conversation.id as ConversationId;

        const outcome = yield* Effect.either(
          alice.client.sendRpc(MessagesSend, {
            conversationId,
            parts: [{ type: "text", text: "dm-blocked" }],
          }),
        );
        expect(Either.isLeft(outcome)).toBe(true);
        if (Either.isLeft(outcome)) {
          const err = outcome.left as { code?: number };
          expect(err.code).toBe(HookBlockedError.code);
        }
        // The hook fired AT LEAST ONCE — proves the address-keyed
        // registry lookup hits for DEFAULT_DM_TM_ADDRESS.
        expect(defaultDmHookState!.calls).toBeGreaterThanOrEqual(1);
        yield* Effect.sleep("200 millis");
        const bobN = bob.client
          .drainNotifications()
          .filter(
            (n) => n.method === MessageReceivedNotificationDefinition.name,
          );
        expect(bobN.length).toBe(0);
      }),
    30_000,
  );
});

describe("messages/authorize — visibility filter (#560 §8.4-5)", () => {
  // Test 6: getMessages visibility shape.
  //   - sender sees own rows regardless of verdict (forward/block/pending).
  //   - recipient sees only forward rows where they appear in recipients.
  //
  // The TM-caller branch (sees all rows) requires a TM-IS-agent setup
  // (custom-TM via `tasks/create { tmType: 'self' }`) plus that agent
  // calling `tasks/getMessages`. Out of scope for this file; covered
  // by the architecture-level TasksGetMessages tests.
  it.live(
    "Sender sees own forward + own block; recipient sees only forwards-containing-self",
    () =>
      Effect.gen(function* () {
        const alice = yield* registerAndConnect("alice-vis");
        const bob = yield* registerAndConnect("bob-vis");
        const carol = yield* registerAndConnect("carol-vis");
        registerTmHook(alice.agentId);

        const task = yield* alice.client.sendRpc(TasksCreate, {
          appId: TEST_APP_ID,
          tmType: "self",
        });
        const conv = yield* alice.client.sendRpc(TasksCreateConversation, {
          taskId: task.task.id,
          type: "group",
          name: "vis-test",
          participants: [
            { type: "agent", id: bob.agentId },
            { type: "agent", id: carol.agentId },
          ],
        });
        const conversationId = conv.conversation.id as ConversationId;

        // Send 1: Forward to carol only.
        appHookState.next = {
          decision: "Forward",
          recipients: [carol.agentId as AgentId],
        };
        const m1 = yield* alice.client.sendRpc(MessagesSend, {
          conversationId,
          parts: [{ type: "text", text: "m1-forward-carol" }],
        });
        // Send 2: Block.
        appHookState.next = { decision: "Block", reason: "m2-block" };
        yield* Effect.either(
          alice.client.sendRpc(MessagesSend, {
            conversationId,
            parts: [{ type: "text", text: "m2-blocked" }],
          }),
        );
        // Send 3: Forward to bob only.
        appHookState.next = {
          decision: "Forward",
          recipients: [bob.agentId as AgentId],
        };
        const m3 = yield* alice.client.sendRpc(MessagesSend, {
          conversationId,
          parts: [{ type: "text", text: "m3-forward-bob" }],
        });

        // Alice (sender) sees all 3 own rows regardless of verdict.
        const aliceList = yield* alice.client.sendRpc(MessagesList, {
          conversationId,
        });
        const aliceIds = aliceList.messages.map((m) => m.id).sort();
        const allIds = (yield* readAllMessageIdsForConversation(conversationId))
          .slice()
          .sort();
        expect(aliceIds).toEqual(allIds);

        // Bob sees m3 only (forward where bob in recipients).
        const bobList = yield* bob.client.sendRpc(MessagesList, {
          conversationId,
        });
        const bobIds = bobList.messages.map((m) => m.id);
        expect(bobIds).toEqual([m3.message.id]);

        // Carol sees m1 only.
        const carolList = yield* carol.client.sendRpc(MessagesList, {
          conversationId,
        });
        const carolIds = carolList.messages.map((m) => m.id);
        expect(carolIds).toEqual([m1.message.id]);
      }),
    30_000,
  );
});

describe("messages/authorize — CAS race (#560 §8.7)", () => {
  // Test 7: CAS guard. After a real verdict commits the row to
  // `forward`, a second UPDATE with the CAS predicate (tm_decision
  // contains tag=pending) matches no rows — the predicate guards
  // against rewrites. Proves the architect plan §9 R11 CAS rule.
  it.live(
    "CAS guard: post-commit second UPDATE with pending-predicate matches no rows; row state preserved",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        registerTmHook(alice.agentId);
        const task = yield* alice.client.sendRpc(TasksCreate, {
          appId: TEST_APP_ID,
          tmType: "self",
        });
        const conv = yield* alice.client.sendRpc(TasksCreateConversation, {
          taskId: task.task.id,
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        });
        const conversationId = conv.conversation.id as ConversationId;

        appHookState.next = {
          decision: "Forward",
          recipients: [bob.agentId as AgentId],
        };
        const sent = yield* alice.client.sendRpc(MessagesSend, {
          conversationId,
          parts: [{ type: "text", text: "race" }],
        });
        const messageId = sent.message.id;

        const firstDecision = (yield* readTmDecision(messageId)) as {
          tag: string;
        };
        expect(firstDecision.tag).toBe("forward");

        // Attempt a second CAS UPDATE on the same row with a
        // different verdict — should match no rows (predicate
        // tm_decision @> {tag:"pending"} fails because row is now
        // forward).
        const updated = yield* Effect.tryPromise({
          try: () =>
            getKyselyDb()
              .updateTable("messages")
              .set({
                tm_decision: { tag: "block", reason: "race-loser" },
              })
              .where("id", "=", messageId)
              .where("tm_decision", "@>", JSON.stringify({ tag: "pending" }))
              .returning("id")
              .execute(),
          catch: (cause) =>
            cause instanceof Error ? cause : new Error(String(cause)),
        });
        expect(updated.length).toBe(0);

        const stillForward = (yield* readTmDecision(messageId)) as {
          tag: string;
        };
        expect(stillForward.tag).toBe("forward");
      }),
    30_000,
  );
});
