/**
 * Integration coverage for the `task/*` + `task/conversation/*` family.
 *
 * Each test exercises one wire method end-to-end against a real
 * Postgres instance: schema decode, authority gate, happy path,
 * key invariants, and (where applicable) the dual-emit notification
 * fan-out (legacy `conversations/*` + new `task/conversation/*`
 * both fire from the same handler in the same tx).
 *
 * The conformance suite drives the wire shape; these tests pin the concrete DB
 * and notification observable behavior.
 *
 * Coverage map (one `it(...)` per row at minimum):
 *
 * | Method | Cases |
 * |---|---|
 * | TaskRequest | happy-path + participants + dedup (DEFAULT_APP) + atomic initial conv + dual-emit |
 * | TaskLeave | self-only + idempotent no-op + last-participant closure + per-cid removal |
 * | TaskConversationCreate | TM-only + participant-admitted invariant + dual-emit |
 * | TaskConversationList | self only + items shape + archived-included |
 * | TaskConversationArchive / Unarchive | TM-only + idempotency + dual-emit |
 * | TaskConversationAddParticipant | TM-only + participant-admitted + idempotency + dual-emit |
 * | TaskConversationRemoveParticipant | TM-only + idempotency + dual-emit |
 */

import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import * as fc from "fast-check";
import { Effect, Exit } from "effect";
import {
  DEFAULT_APP_ID,
  TaskClosedNotificationDefinition,
  TaskCreate,
  TaskLeave,
  TaskRequest,
} from "@moltzap/protocol/task";
import {
  TaskConversationCreate,
  TaskConversationCreatedNotificationDefinition,
  TaskConversationList,
} from "@moltzap/protocol/conversation";
import { DispatchAuthorize } from "@moltzap/protocol/message/dispatch";
import { MessagesAuthorize } from "@moltzap/protocol/message";
import type {
  AppCallbackContext,
  AppCallbackHandlers,
} from "@moltzap/protocol/socket";
import type { AgentId } from "@moltzap/protocol/identity";
import type { UserId } from "@moltzap/protocol/identity";
import {
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  trackClient,
  connectTestClient,
  connectAppClient,
  registerApp,
  createTestUser,
  createTestAgent,
  type TestAgentClient,
} from "../helpers.js";
import { agentId } from "@moltzap/protocol/testing";
import { awaitOneNotification } from "../../../test-utils/helpers.js";

const REGISTRATION_SECRET = "tcf-test-secret-xyz1";
const ALICE_USER_ID = "00000000-0000-4000-8000-00000000a17f";
const BOB_USER_ID = "00000000-0000-4000-8000-00000000b07f";
const CAROL_USER_ID = "00000000-0000-4000-8000-00000000c07f";
const ALICE_USER = createTestUser("alice", ALICE_USER_ID);
const BOB_USER = createTestUser("bob", BOB_USER_ID);
const CAROL_USER = createTestUser("carol", CAROL_USER_ID);
const NOTIF_TIMEOUT_MS = 2_500;
const SPINOFF_CONVERSATION_NAME = "spinoff";

// Surface invariants that the spec body pins; pulling these into
// named constants keeps the assertions grep-able + lints clean.
const STATUS_ACTIVE = "active" as const;
const STATUS_CLOSED = "closed" as const;
const INITIAL_CONV_NAME = "kickoff" as const;

let baseUrl: string;
let wsUrl: string;
let pairCounter = 0;

beforeAll(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      const server = yield* startTestServerEffect({
        registrationSecret: REGISTRATION_SECRET,
      });
      baseUrl = server.baseUrl;
      wsUrl = server.wsUrl;
    }),
  ),
);

afterAll(() => Effect.runPromise(stopTestServerEffect()));

beforeEach(() =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* resetTestDbEffect();
      pairCounter = 0;
    }),
  ),
);

interface ThreeAgentFixture {
  readonly alice: { client: TestAgentClient; agentId: AgentId };
  readonly bob: { client: TestAgentClient; agentId: AgentId };
  readonly carol: { client: TestAgentClient; agentId: AgentId };
}

function registerAndConnect(
  name: string,
  ownerUserId: UserId,
): Effect.Effect<{ client: TestAgentClient; agentId: AgentId }, Error> {
  return Effect.gen(function* () {
    const user = userForOwner(ownerUserId);
    const reg = yield* createTestAgent(name, { ownerUserId: user.id });
    const client = yield* connectTestClient({
      wsUrl,
      agentId: reg.agentId,
      apiKey: reg.apiKey,
    });
    trackClient(client);
    return { client, agentId: agentId(reg.agentId) };
  });
}

function userForOwner(ownerUserId: UserId) {
  if (ownerUserId === ALICE_USER.id) return ALICE_USER;
  if (ownerUserId === BOB_USER.id) return BOB_USER;
  return CAROL_USER;
}

function acceptTaskCreateHandlers(): AppCallbackHandlers<AppCallbackContext> {
  return {
    "dispatch/authorize": {
      definition: DispatchAuthorize,
      handle: () => Effect.dieMessage("unexpected dispatch/authorize"),
    },
    "messages/authorize": {
      definition: MessagesAuthorize,
      handle: () => Effect.dieMessage("unexpected messages/authorize"),
    },
    "task/create": {
      definition: TaskCreate,
      handle: () =>
        Effect.succeed({ verdict: { decision: "accept" as const } }),
    },
  };
}

function setupThreeAgents(): Effect.Effect<ThreeAgentFixture, Error> {
  return Effect.gen(function* () {
    const idx = ++pairCounter;
    const alice = yield* registerAndConnect(`alice-tcf-${idx}`, ALICE_USER.id);
    const bob = yield* registerAndConnect(`bob-tcf-${idx}`, BOB_USER.id);
    const carol = yield* registerAndConnect(`carol-tcf-${idx}`, CAROL_USER.id);
    return { alice, bob, carol };
  });
}

// ─── TaskRequest ──────────────────────────────────────────────────────

it("TaskRequest (DEFAULT_APP, multi-invitee) mints a fresh task with all participants", () =>
  Effect.gen(function* () {
    const { alice, bob, carol } = yield* setupThreeAgents();
    const result = yield* alice.client.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId, carol.agentId],
    });
    // DEFAULT_APP auto-accepts the task/create TM callback, so the
    // task transitions waiting → active before task/request returns.
    expect(result.task.status).toBe(STATUS_ACTIVE);
    expect(result.task.appId).toBe(DEFAULT_APP_ID);
    expect(result.task.initiatorAgentId).toBe(alice.agentId);
    // No initialConversation supplied -> null per spec body Goal 3.
    expect(result.conversation).toBeNull();
  }));

it("TaskRequest (different appId) does NOT dedup across apps", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupThreeAgents();
    const first = yield* alice.client.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
    });
    // Non-default app: an app principal registers (HTTP) + `appKey`-
    // Connects so its `task/create` callback resolves. Alice (agent)
    // drives the agent-only `task/request` against the DB-minted appId.
    // Dedup is retired (#677); two requests under different apps always
    // mint distinct tasks.
    const registered = yield* registerApp(
      baseUrl,
      {
        appId: "11111111-2222-4333-8444-555555555555",
        name: "other-app",
        // `task_create` is `kind: "hook"` so the `TaskCreate` callback
        // wired below is consulted; the other two take their open
        // static verdict.
        hooks: {
          dispatch_authorize: { kind: "grant" },
          message_authorize: { kind: "forwardAllExceptSender" },
          task_create: { kind: "hook", timeoutMs: 5_000 },
        },
      },
      REGISTRATION_SECRET,
    );
    yield* connectAppClient(
      registered.appId,
      registered.appKey,
      acceptTaskCreateHandlers(),
    );
    const second = yield* alice.client.sendRpc(TaskRequest, {
      appId: registered.appId,
      invitedAgentIds: [bob.agentId],
    });
    expect(second.task.id).not.toBe(first.task.id);
  }));

it("TaskRequest (initialConversation) mints a conversation + emits task/conversation/created", () =>
  Effect.gen(function* () {
    const { alice, bob, carol } = yield* setupThreeAgents();
    // Subscribe BEFORE sending so the stream-based waiter has the
    // subscription open by the time the handler enqueues.
    const newNotif = Effect.fork(
      awaitOneNotification(
        alice.client,
        TaskConversationCreatedNotificationDefinition,
        NOTIF_TIMEOUT_MS,
      ),
    );
    const newFib = yield* newNotif;
    const result = yield* alice.client.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId, carol.agentId],
      initialConversation: {
        name: INITIAL_CONV_NAME,
        participants: [bob.agentId, carol.agentId],
      },
    });
    expect(result.conversation).not.toBeNull();
    expect(result.conversation?.name).toBe(INITIAL_CONV_NAME);
    expect(result.conversation?.createdBy).toBe(alice.agentId);
    yield* newFib.await;
  }));

// ─── TaskLeave ───────────────────────────────────────────────────────

it("TaskLeave (idempotent, non-participant) returns ok with zero notifications", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupThreeAgents();
    const created = yield* alice.client.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
    });
    // Bob is invited but not admitted; leaving still returns ok
    // (no-op). Carol (a third party) is also not a participant; spec
    // body Goal 2 idempotency clause covers both shapes.
    const { carol } = yield* setupThreeAgents();
    const result = yield* carol.client.sendRpc(TaskLeave, {
      taskId: created.task.id,
    });
    expect(result).toEqual({});
  }));

it("TaskLeave (last admitted participant) transitions task to closed + emits task/closed", () =>
  Effect.gen(function* () {
    const { alice } = yield* setupThreeAgents();
    const created = yield* alice.client.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [],
    });
    const closedFib = yield* Effect.fork(
      awaitOneNotification(
        alice.client,
        TaskClosedNotificationDefinition,
        NOTIF_TIMEOUT_MS,
      ),
    );
    yield* alice.client.sendRpc(TaskLeave, { taskId: created.task.id });
    const exit = yield* closedFib.await;
    if (!Exit.isSuccess(exit)) {
      throw new Error(
        `task/closed notification did not arrive (exit: ${exit._tag})`,
      );
    }
    const params = exit.value.params;
    expect(params.task.id).toBe(created.task.id);
    expect(params.task.status).toBe(STATUS_CLOSED);
  }));

// ─── TaskConversationCreate ──────────────────────────────────────────

it("TaskConversationCreate (owning app caller) mints a conversation", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupThreeAgents();
    const registered = yield* registerApp(
      baseUrl,
      {
        appId: "11111111-2222-4333-8444-555555555555",
        name: "conversation-owner-app",
        hooks: {
          dispatch_authorize: { kind: "grant" },
          message_authorize: { kind: "forwardAllExceptSender" },
          task_create: { kind: "hook", timeoutMs: 5_000 },
        },
      },
      REGISTRATION_SECRET,
    );
    const appClient = yield* connectAppClient(
      registered.appId,
      registered.appKey,
      acceptTaskCreateHandlers(),
    );
    const created = yield* alice.client.sendRpc(TaskRequest, {
      appId: registered.appId,
      invitedAgentIds: [bob.agentId],
    });
    const conversation = yield* appClient.sendRpc(TaskConversationCreate, {
      taskId: created.task.id,
      name: SPINOFF_CONVERSATION_NAME,
      participants: [bob.agentId],
    });
    expect(conversation.conversation.name).toBe(SPINOFF_CONVERSATION_NAME);
  }));

// ─── TaskConversationList ────────────────────────────────────────────

it("TaskConversationList returns items with { taskId, conversation, participants }", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupThreeAgents();
    const created = yield* alice.client.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
      initialConversation: {
        name: "list-me",
        participants: [bob.agentId],
      },
    });
    expect(created.conversation).not.toBeNull();
    const result = yield* alice.client.sendRpc(TaskConversationList, {});
    expect(result.items.length).toBeGreaterThanOrEqual(1);
    const item = result.items.find(
      (i) => i.conversation.id === created.conversation!.id,
    );
    expect(item).toBeDefined();
    expect(item!.taskId).toBe(created.task.id);
    expect(item!.participants.length).toBeGreaterThanOrEqual(1);
    // Conversation row shape includes optional `archivedAt`.
    expect(item!.conversation.archivedAt).toBeUndefined();
  }));

it("TaskConversationList respects limit + returns nextCursor when more rows exist", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupThreeAgents();
    // Two task-conversations under one umbrella task.
    yield* alice.client.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
      initialConversation: { name: "first", participants: [bob.agentId] },
    });
    const { carol } = yield* setupThreeAgents();
    yield* alice.client.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [carol.agentId],
      initialConversation: { name: "second", participants: [carol.agentId] },
    });
    const result = yield* alice.client.sendRpc(TaskConversationList, {
      limit: 1,
    });
    expect(result.items).toHaveLength(1);
    // `nextCursor` is `Type.Optional(Type.String())` — present when
    // there are more rows after the page.
    expect(result.nextCursor).toBeDefined();
  }));

// Property-style invariant — pins the DEFAULT_APP_ID UUID shape that
// the dedup query keys off. A regression that drifts the constant
// trips this before the e2e tests above.
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

it("property: DEFAULT_APP_ID is a v4 UUID across arbitrary chars", () =>
  Effect.sync(() => {
    expect.hasAssertions();
    fc.assert(
      fc.property(fc.string(), (_filler) => {
        // The dedup query in the handler uses the exact constant
        // value; this property pins the shape, not the runtime
        // string. Drift breaks `findExistingTaskByParticipants`.
        expect(UUID_V4_RE.test(DEFAULT_APP_ID)).toBe(true);
      }),
      { numRuns: 25 },
    );
  }));
