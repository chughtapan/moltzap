/**
 * Prereq 1 — `apps/authorizeDispatch` routing now reads `tasks.app_id`
 * via {@link lookupAppForConversation}, replacing the dead in-memory
 * `conversationToSession` cache that lived on `AppHost`. Pin three
 * shapes the new path must preserve:
 *
 *  - **AppBound**: a task created with `appId` + an in-process hook
 *    registered for that `appId` → `apps/authorizeDispatch` routes
 *    through the hook (the hook's verdict reaches the caller).
 *  - **NoAppSession**: a default-task conversation (`app_id IS NULL`)
 *    → `apps/authorizeDispatch` returns `grant` without consulting any
 *    registered hook (a counter on the hook stays at zero).
 *  - **ConversationArchived**: an archived conversation → `apps/authorizeDispatch`
 *    returns `deny` with `reason: "conversation_archived"`, regardless
 *    of whether the parent task has an `app_id`.
 *
 * Setup uses ONLY wire RPCs and the public `CoreApp` surface
 * (`registerApp`, `onTaskAuthorizeDispatch`) — same path arena's
 * werewolf moderator drives, so the suite exercises the same
 * production routing that consumers depend on.
 */
import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import {
  AppsAuthorizeDispatch,
  ConversationsArchive,
  ConversationsCreate,
  TasksCreate,
  TasksCreateConversation,
  type AppManifest,
  type ConversationId,
  type MessageId,
} from "@moltzap/protocol";
import { agentId as protocolAgentId } from "@moltzap/protocol/testing";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  setupAgentPair,
  getTestCoreApp,
} from "./helpers.js";

const TEST_APP_ID = "moderator-test-app";
const MODERATOR_DENY_REASON = "moderator-test-deny";

const TEST_APP_MANIFEST: AppManifest = {
  appId: TEST_APP_ID,
  name: "Moderator Test App",
  conversations: [{ key: "main", name: "Main", participantFilter: "all" }],
};

let hookConsultations = 0;

beforeAll(async () => {
  await startTestServer();
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
  hookConsultations = 0;

  // Register the test app + hook every test. `resetTestDb` does not
  // touch `AppHost`'s in-memory hook map, but `onTaskAuthorizeDispatch`
  // overwrites the prior closure (see `app-host.ts` `onTaskAuthorizeDispatch`),
  // re-pinning the counter to the freshly-zeroed `hookConsultations`.
  const coreApp = getTestCoreApp();
  coreApp.registerApp(TEST_APP_MANIFEST);
  coreApp.onTaskAuthorizeDispatch(TEST_APP_ID, () => {
    hookConsultations += 1;
    return { decision: "deny" as const, reason: MODERATOR_DENY_REASON };
  });
});

/**
 * Synthetic message id for `apps/authorizeDispatch` admission probes.
 * The verb does not write the message — it only consults the moderator
 * — so the id need only satisfy the schema (UUID-shaped string per the
 * `MessageId` brand at `schema-primitives.ts`).
 */
function makeProbeMessageId(): MessageId {
  return crypto.randomUUID() as MessageId;
}

describe("apps/authorizeDispatch — task→app routing via DB lookup", () => {
  it.live(
    "AppBound: task with app_id + registered hook → hook fires; verdict reaches caller",
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

        const result = yield* bob.client.sendRpc(AppsAuthorizeDispatch, {
          conversationId: conv.conversation.id,
          messageId: makeProbeMessageId(),
          senderAgentId: protocolAgentId(alice.agentId),
          parts: [{ type: "text", text: "probe" }],
        });
        expect(hookConsultations).toBe(1);
        expect(result.admission.decision).toBe("deny");
        if (result.admission.decision === "deny") {
          expect(result.admission.reason).toBe(MODERATOR_DENY_REASON);
        }
      }),
    20_000,
  );

  it.live(
    "NoAppSession: task with app_id IS NULL → grant returned; hook NOT consulted",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        // `conversations/create` mints an auto-task with `app_id IS NULL`
        // (default-DM TM bound, no app session). This is the path most
        // wire-level callers hit when sending DMs.
        const conv = yield* alice.client.sendRpc(ConversationsCreate, {
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        });

        const result = yield* bob.client.sendRpc(AppsAuthorizeDispatch, {
          conversationId: conv.conversation.id,
          messageId: makeProbeMessageId(),
          senderAgentId: protocolAgentId(alice.agentId),
          parts: [{ type: "text", text: "probe" }],
        });
        expect(result.admission.decision).toBe("grant");
        // Counter zero proves the moderator hook was not invoked — the
        // dead-Map default path also returned grant, but only because the
        // Map was empty; this assertion rules out the false positive
        // where the new lookup accidentally routes a NoAppSession through
        // the hook map for a different `appId`.
        expect(hookConsultations).toBe(0);
      }),
    20_000,
  );

  it.live(
    "ConversationArchived: archived conversation → deny with reason 'conversation_archived'",
    () =>
      Effect.gen(function* () {
        const { alice, bob } = yield* setupAgentPair();
        const conv = yield* alice.client.sendRpc(ConversationsCreate, {
          type: "dm",
          participants: [{ type: "agent", id: bob.agentId }],
        });
        yield* alice.client.sendRpc(ConversationsArchive, {
          conversationId: conv.conversation.id as ConversationId,
        });

        const result = yield* bob.client.sendRpc(AppsAuthorizeDispatch, {
          conversationId: conv.conversation.id,
          messageId: makeProbeMessageId(),
          senderAgentId: protocolAgentId(alice.agentId),
          parts: [{ type: "text", text: "probe" }],
        });
        expect(result.admission.decision).toBe("deny");
        if (result.admission.decision === "deny") {
          expect(result.admission.reason).toBe("conversation_archived");
        }
        expect(hookConsultations).toBe(0);
      }),
    20_000,
  );
});
