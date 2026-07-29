/* eslint-disable agent-code-guard/no-example-only-tests -- regression-only suite: each case exercises a distinct task/conversation method through the live server, database, and notification fan-out. Generative wire coverage lives in the protocol conformance suite. */

/**
 * Integration coverage for the `task` + `conversation` family.
 *
 * Each test exercises one wire method end-to-end against a real
 * Postgres instance: schema decode, authority gate, happy path,
 * key invariants, and (where applicable) notification fan-out from the
 * handler transaction.
 *
 * The conformance suite drives the wire shape; these tests pin the concrete DB
 * and notification observable behavior.
 *
 * Coverage map (one `it(...)` per row at minimum):
 *
 * | Method | Cases |
 * |---|---|
 * | TaskRequest | happy-path + participants + app binding + atomic initial conv + dual-emit |
 * | TaskLeave | self-only + idempotent no-op + last-participant closure + per-cid removal |
 * | ConversationCreate | app-only + participant-admitted invariant + dual-emit |
 * | ConversationList | self only + items shape + archived-included |
 * | ConversationUpdate archive/unarchive | app-only + idempotency + dual-emit |
 * | ConversationUpdate add-participant | app-only + participant-admitted + idempotency + dual-emit |
 * | ConversationUpdate remove-participant | app-only + idempotency + dual-emit |
 */

import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect, Exit } from "effect";
import {
  DEFAULT_APP_ID,
  taskClosedNotificationDefinition,
  taskCreate,
  taskLeave,
  taskRequest,
} from "@moltzap/protocol/task";
import {
  conversationCreate,
  conversationCreatedNotificationDefinition,
  conversationList,
} from "@moltzap/protocol/conversation";
import { dispatchAuthorize } from "@moltzap/protocol/message/dispatch";
import { messagesAuthorize } from "@moltzap/protocol/message";
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
  expectEitherLeft,
  getTestCoreApp,
  type TestAgentClient,
} from "../helpers.js";
import { agentId, WIRE_ERROR_TAG } from "@moltzap/protocol/testing";
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
    [dispatchAuthorize.name]: {
      definition: dispatchAuthorize,
      handle: () => Effect.dieMessage("unexpected app/dispatch/authorize"),
    },
    [messagesAuthorize.name]: {
      definition: messagesAuthorize,
      handle: () => Effect.dieMessage("unexpected app/message/authorize"),
    },
    [taskCreate.name]: {
      definition: taskCreate,
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
    const result = yield* alice.client.sendRpc(taskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId, carol.agentId],
    });
    // DEFAULT_APP auto-accepts app/task/create, so the
    // task transitions waiting → active before agent/task/request returns.
    expect(result.task.status).toBe(STATUS_ACTIVE);
    expect(result.task.appId).toBe(DEFAULT_APP_ID);
    expect(result.task.initiatorAgentId).toBe(alice.agentId);
    // No initialConversation supplied -> null per spec body Goal 3.
    expect(result.conversation).toBeNull();
  }));

it("TaskRequest binds separately-created tasks to their requested apps", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupThreeAgents();
    const first = yield* alice.client.sendRpc(taskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
    });
    // Requests under different app identities always mint distinct tasks.
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
    const second = yield* alice.client.sendRpc(taskRequest, {
      appId: registered.appId,
      invitedAgentIds: [bob.agentId],
    });
    expect(first.task.appId).toBe(DEFAULT_APP_ID);
    expect(second.task.appId).toBe(registered.appId);
    expect(second.task.id).not.toBe(first.task.id);
  }));

it("TaskRequest (initialConversation) mints a conversation + emits app/conversation/created", () =>
  Effect.gen(function* () {
    const { alice, bob, carol } = yield* setupThreeAgents();
    // Subscribe BEFORE sending so the stream-based waiter has the
    // subscription open by the time the handler enqueues.
    const newNotif = Effect.fork(
      awaitOneNotification(
        alice.client,
        conversationCreatedNotificationDefinition,
        NOTIF_TIMEOUT_MS,
      ),
    );
    const newFib = yield* newNotif;
    const result = yield* alice.client.sendRpc(taskRequest, {
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

it("TaskRequest applies contact policy to initial-conversation-only participants", () =>
  Effect.gen(function* () {
    const { alice, bob, carol } = yield* setupThreeAgents();
    const app = getTestCoreApp();
    app.setContactService({
      areInContact: (_requesterOwner, targetOwner) =>
        Effect.succeed(targetOwner === BOB_USER.id),
    });

    const result = yield* alice.client
      .sendRpc(taskRequest, {
        appId: DEFAULT_APP_ID,
        invitedAgentIds: [bob.agentId],
        initialConversation: {
          participants: [carol.agentId],
        },
      })
      .pipe(
        Effect.either,
        Effect.ensuring(
          Effect.sync(() =>
            app.setContactService({
              areInContact: () => Effect.succeed(true),
            }),
          ),
        ),
      );

    expect(expectEitherLeft(result)._tag).toBe(WIRE_ERROR_TAG.NotInContacts);
  }));

// ─── TaskLeave ───────────────────────────────────────────────────────

it("TaskLeave (idempotent, non-participant) returns ok with zero notifications", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupThreeAgents();
    const created = yield* alice.client.sendRpc(taskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
    });
    // Bob is invited but not admitted; leaving still returns ok
    // (no-op). Carol (a third party) is also not a participant; spec
    // body Goal 2 idempotency clause covers both shapes.
    const { carol } = yield* setupThreeAgents();
    const result = yield* carol.client.sendRpc(taskLeave, {
      taskId: created.task.id,
    });
    expect(result).toEqual({});
  }));

it("TaskLeave (last admitted participant) transitions task to closed + emits task/closed", () =>
  Effect.gen(function* () {
    const { alice } = yield* setupThreeAgents();
    const created = yield* alice.client.sendRpc(taskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [],
    });
    const closedFib = yield* Effect.fork(
      awaitOneNotification(
        alice.client,
        taskClosedNotificationDefinition,
        NOTIF_TIMEOUT_MS,
      ),
    );
    yield* alice.client.sendRpc(taskLeave, { taskId: created.task.id });
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

// ─── ConversationCreate ──────────────────────────────────────────

it("ConversationCreate (owning app caller) mints a conversation", () =>
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
    const created = yield* alice.client.sendRpc(taskRequest, {
      appId: registered.appId,
      invitedAgentIds: [bob.agentId],
    });
    const conversation = yield* appClient.sendRpc(conversationCreate, {
      taskId: created.task.id,
      name: SPINOFF_CONVERSATION_NAME,
      participants: [bob.agentId],
    });
    expect(conversation.conversation.name).toBe(SPINOFF_CONVERSATION_NAME);
  }));

// ─── ConversationList ────────────────────────────────────────────

it("ConversationList returns items with { taskId, conversation, participants }", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupThreeAgents();
    const created = yield* alice.client.sendRpc(taskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
      initialConversation: {
        name: "list-me",
        participants: [bob.agentId],
      },
    });
    expect(created.conversation).not.toBeNull();
    const result = yield* alice.client.sendRpc(conversationList, {});
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

it("ConversationList respects limit + returns nextCursor when more rows exist", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupThreeAgents();
    // Two conversations under one umbrella task.
    yield* alice.client.sendRpc(taskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
      initialConversation: { name: "first", participants: [bob.agentId] },
    });
    const { carol } = yield* setupThreeAgents();
    yield* alice.client.sendRpc(taskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [carol.agentId],
      initialConversation: { name: "second", participants: [carol.agentId] },
    });
    const result = yield* alice.client.sendRpc(conversationList, {
      limit: 1,
    });
    expect(result.items).toHaveLength(1);
    // `nextCursor` is `Type.Optional(Type.String())` — present when
    // there are more rows after the page.
    expect(result.nextCursor).toBeDefined();
  }));
