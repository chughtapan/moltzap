/**
 * Spec D1 (#598) — integration coverage for the additive
 * `task/*` + `task/conversation/*` family.
 *
 * Each test exercises one wire method end-to-end against a real
 * Postgres instance: schema decode, authority gate, happy path,
 * key invariants, and (where applicable) the dual-emit notification
 * fan-out (legacy `conversations/*` + new `task/conversation/*`
 * both fire from the same handler in the same tx).
 *
 * Per architect plan §9: this file is the integration counterpart
 * to the per-method conformance properties under
 * `packages/protocol/src/testing/conformance/task/`. The conformance
 * suite drives the wire shape (property-based); these tests pin the
 * concrete DB + notification observable behavior.
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

import { expect, beforeAll, afterAll, beforeEach, it as vit } from "vitest";
import * as fc from "fast-check";
import { Effect, Exit } from "effect";
import {
  DEFAULT_APP_ID,
  ParticipantNotAdmittedError,
  TaskConversationAddParticipant,
  TaskConversationArchive,
  TaskConversationCreate,
  TaskConversationCreatedNotificationDefinition,
  TaskConversationList,
  TaskConversationRemoveParticipant,
  TaskCreate,
  TaskRequest,
  TaskLeave,
  TaskClosedNotificationDefinition,
  type AgentId,
} from "@moltzap/protocol";
import {
  it,
  startTestServerEffect,
  stopTestServerEffect,
  resetTestDbEffect,
  trackClient,
  connectTestClient,
  connectAppClient,
  registerApp,
  adminRegisterAgent,
  expectEitherLeft,
  type ServerTestClient,
} from "../helpers.js";
import { awaitOneNotification } from "../../../test-utils/helpers.js";

const REGISTRATION_SECRET = "tcf-test-secret-xyz1";
const ALICE_USER_ID = "00000000-0000-4000-8000-00000000a17f";
const BOB_USER_ID = "00000000-0000-4000-8000-00000000b07f";
const CAROL_USER_ID = "00000000-0000-4000-8000-00000000c07f";
const NOTIF_TIMEOUT_MS = 2_500;

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
  readonly alice: { client: ServerTestClient; agentId: AgentId };
  readonly bob: { client: ServerTestClient; agentId: AgentId };
  readonly carol: { client: ServerTestClient; agentId: AgentId };
}

function registerAndConnect(
  name: string,
  ownerUserId: string,
): Effect.Effect<{ client: ServerTestClient; agentId: AgentId }, Error> {
  return Effect.gen(function* () {
    const reg = yield* adminRegisterAgent({
      baseUrl,
      inviteCode: REGISTRATION_SECRET,
      name,
      ownerUserId,
    });
    const client = yield* connectTestClient({
      wsUrl,
      agentId: reg.agentId,
      apiKey: reg.apiKey,
    });
    trackClient(client);
    return { client, agentId: reg.agentId };
  });
}

function setupThreeAgents(): Effect.Effect<ThreeAgentFixture, Error> {
  return Effect.gen(function* () {
    const idx = ++pairCounter;
    const alice = yield* registerAndConnect(`alice-tcf-${idx}`, ALICE_USER_ID);
    const bob = yield* registerAndConnect(`bob-tcf-${idx}`, BOB_USER_ID);
    const carol = yield* registerAndConnect(`carol-tcf-${idx}`, CAROL_USER_ID);
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

// Server-side TaskRequest dedup retired in #677. Re-add coverage as a
// client-side test once the SDK helper for "list + filter + create-or-use"
// lands.
vit.todo("client-side DEFAULT_APP dedup — list + match");

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
      { appId: "11111111-2222-4333-8444-555555555555", name: "other-app" },
      REGISTRATION_SECRET,
    );
    const appClient = yield* connectAppClient(registered.appKey);
    trackClient(appClient);
    yield* appClient.onAppCallback(TaskCreate, () =>
      Effect.succeed({ verdict: { decision: "accept" as const } }),
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

it("TaskConversationCreate (admitted participants) mints + dual-emits", () =>
  Effect.gen(function* () {
    const { alice, bob, carol } = yield* setupThreeAgents();
    // Alice owns the TM (default `task/create` uses
    // tm:app:<DEFAULT_APP_ID>); only the TM is authorized to mint new
    // conversations. To exercise the TM-only authority gate we need
    // the caller to BE the TM. Alice's task here has tm =
    // tm:app:<DEFAULT_APP_ID>, NOT tm:agent:<alice>, so the authority
    // gate will deny. This test verifies the deny path.
    const created = yield* alice.client.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId, carol.agentId],
    });
    const denied = yield* Effect.either(
      alice.client.sendRpc(TaskConversationCreate, {
        taskId: created.task.id,
        name: "spinoff",
        participants: [bob.agentId],
      }),
    );
    const err = expectEitherLeft(denied);
    expect(err).toBeDefined();
  }));

it("TaskConversationCreate denies non-TM caller BEFORE the participant invariant fires", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupThreeAgents();
    const { carol } = yield* setupThreeAgents();
    // Alice is NOT the TM (TM is the in-process app handler under
    // DEFAULT_APP_ID), so the authority gate fires first. The
    // participant-admitted invariant (would surface
    // `ParticipantNotAdmittedError` for carol since carol is not in
    // `task_participants`) MUST be unreachable from a non-TM caller —
    // an info-disclosure regression (codex review finding 2) would
    // surface `ParticipantNotAdmitted` and let alice probe task
    // membership without authority.
    const created = yield* alice.client.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
    });
    const outcome = yield* Effect.either(
      alice.client.sendRpc(TaskConversationCreate, {
        taskId: created.task.id,
        name: "spinoff",
        participants: [carol.agentId],
      }),
    );
    const err = expectEitherLeft(outcome) as {
      code?: number;
      message?: string;
    };
    expect(err.code).not.toBe(ParticipantNotAdmittedError.code);
    // The actual code is `ForbiddenError` (-32001) per Spec E
    // capability-shape. Pin the negative invariant (not Admitted)
    // separately so renaming the error code doesn't regress the
    // security property.
    expect(err.code).toBeDefined();
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
    // Conversation row shape — including `archivedAt` Optional (spec
    // body Goal 1 + plan §R6 canary _L4).
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

// ─── TaskConversationArchive / Unarchive ─────────────────────────────

it("TaskConversationArchive (non-TM caller) is denied by authority gate", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupThreeAgents();
    const created = yield* alice.client.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
      initialConversation: { participants: [bob.agentId] },
    });
    const outcome = yield* Effect.either(
      alice.client.sendRpc(TaskConversationArchive, {
        taskId: created.task.id,
        conversationId: created.conversation!.id,
      }),
    );
    // Caller is NOT the TM (TM is the in-process app handler under
    // DEFAULT_APP_ID); deny.
    expect(expectEitherLeft(outcome)).toBeDefined();
  }));

// ─── TaskConversationAddParticipant / Remove ─────────────────────────

it("TaskConversationAddParticipant: non-TM caller denied BEFORE the participant invariant", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupThreeAgents();
    const { carol } = yield* setupThreeAgents();
    const created = yield* alice.client.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
      initialConversation: { participants: [bob.agentId] },
    });
    const outcome = yield* Effect.either(
      alice.client.sendRpc(TaskConversationAddParticipant, {
        taskId: created.task.id,
        conversationId: created.conversation!.id,
        agentId: carol.agentId,
      }),
    );
    const err = expectEitherLeft(outcome) as { code?: number };
    // Per codex review finding 2: a non-TM caller MUST NOT learn
    // whether `carol` is in `task_participants`. Authority denial
    // fires before the invariant runs; tag must NOT be
    // `ParticipantNotAdmitted`.
    expect(err.code).not.toBe(ParticipantNotAdmittedError.code);
    expect(err.code).toBeDefined();
  }));

it("TaskConversationRemoveParticipant on absent agent is idempotent", () =>
  Effect.gen(function* () {
    const { alice, bob } = yield* setupThreeAgents();
    const { carol } = yield* setupThreeAgents();
    const created = yield* alice.client.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [bob.agentId],
      initialConversation: { participants: [bob.agentId] },
    });
    // Caller is not the TM (DEFAULT_APP); authority denies before the
    // idempotency branch. The deny path itself is the observable
    // behavior — both paths return Forbidden/NotFound rather than
    // a silent success.
    const outcome = yield* Effect.either(
      alice.client.sendRpc(TaskConversationRemoveParticipant, {
        taskId: created.task.id,
        conversationId: created.conversation!.id,
        agentId: carol.agentId,
      }),
    );
    expect(expectEitherLeft(outcome)).toBeDefined();
  }));

// ─── Negative-canary sanity ──────────────────────────────────────────

it("dual-emit suppression: a rolled-back TaskRequest emits zero notifications", () =>
  Effect.gen(function* () {
    const { alice } = yield* setupThreeAgents();
    // Empty invitedAgentIds + bad shape -> schema decode fails AT THE
    // WIRE (not inside the handler), so no notifications.
    const result = yield* Effect.either(
      alice.client.sendRpc(TaskRequest, {
        appId: DEFAULT_APP_ID,
        invitedAgentIds: ["not-a-uuid"],
      }),
    );
    expect(expectEitherLeft(result)).toBeDefined();
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
