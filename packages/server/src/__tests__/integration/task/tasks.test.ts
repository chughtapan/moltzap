import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import { DispatchAuthorize } from "@moltzap/protocol/message/dispatch";
import {
  DEFAULT_APP_ID,
  TaskCreate,
  TaskList,
  TaskRequest,
  TaskUpdate,
} from "@moltzap/protocol/task";
import { MessagesAuthorize } from "@moltzap/protocol/message";
import type {
  AppCallbackContext,
  AppCallbackHandlers,
} from "@moltzap/protocol/socket";
import type { AppManifest } from "@moltzap/protocol/identity";
import { agentId } from "@moltzap/protocol/testing";
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
  registerOwnedAgent,
  type TestAgentClient,
} from "../helpers.js";

const REGISTRATION_SECRET = "tasks-test-secret-mnop";
const ALICE_USER = createTestUser(
  "alice",
  "00000000-0000-4000-8000-00000000a11d",
);
const BOB_USER = createTestUser("bob", "00000000-0000-4000-8000-00000000b0b1");
const ACTIVE_STATUS = "active";
const CLOSED_STATUS = "closed";
const TASK_MANAGER_MANIFEST = {
  appId: "00000000-0000-4000-8000-000000010007",
  name: "tm-test-app",
  hooks: {
    dispatch_authorize: { kind: "grant" },
    message_authorize: { kind: "forwardAllExceptSender" },
    task_create: { kind: "hook", timeoutMs: 5_000 },
  },
} satisfies AppManifest;

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

function setupAliceAndBob(): Effect.Effect<
  {
    aliceClient: TestAgentClient;
    bobClient: TestAgentClient;
    aliceAgentId: string;
    bobAgentId: string;
  },
  Error
> {
  return Effect.gen(function* () {
    const idx = ++pairCounter;
    const aliceReg = yield* registerOwnedAgent({
      baseUrl,
      inviteCode: REGISTRATION_SECRET,
      name: `alice-tasks-${idx}`,
      user: ALICE_USER,
    });
    const bobReg = yield* registerOwnedAgent({
      baseUrl,
      inviteCode: REGISTRATION_SECRET,
      name: `bob-tasks-${idx}`,
      user: BOB_USER,
    });
    const aliceClient = yield* connectTestClient({
      wsUrl,
      agentId: aliceReg.agentId,
      apiKey: aliceReg.apiKey,
    });
    trackClient(aliceClient);
    const bobClient = yield* connectTestClient({
      wsUrl,
      agentId: bobReg.agentId,
      apiKey: bobReg.apiKey,
    });
    trackClient(bobClient);
    return {
      aliceClient,
      bobClient,
      aliceAgentId: aliceReg.agentId,
      bobAgentId: bobReg.agentId,
    };
  });
}

function acceptTaskCreateHandlers(): AppCallbackHandlers<AppCallbackContext> {
  return {
    [DispatchAuthorize.name]: {
      definition: DispatchAuthorize,
      handle: () => Effect.dieMessage("unexpected app/dispatch/authorize"),
    },
    [MessagesAuthorize.name]: {
      definition: MessagesAuthorize,
      handle: () => Effect.dieMessage("unexpected app/message/authorize"),
    },
    [TaskCreate.name]: {
      definition: TaskCreate,
      handle: () =>
        Effect.succeed({ verdict: { decision: "accept" as const } }),
    },
  };
}

it("agent/task/request returns an active task bound to the supplied appId", () =>
  Effect.gen(function* () {
    const { aliceClient, aliceAgentId } = yield* setupAliceAndBob();
    const result = yield* aliceClient.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [],
    });
    // DEFAULT_APP auto-accepts app/task/create, so the task becomes active.
    expect(result.task.status).toBe(ACTIVE_STATUS);
    expect(result.task.initiatorAgentId).toBe(aliceAgentId);
    expect(result.task.appId).toBe(DEFAULT_APP_ID);
  }));

it("app authority: only the app principal may mutate task membership", () =>
  Effect.gen(function* () {
    const { aliceClient, bobAgentId } = yield* setupAliceAndBob();
    // `app/task/update` heads its `requires` with `AppPrincipal`. The
    // app authority client registers via HTTP, then
    // `appKey`-Connects to bind its `AppConnection` as the app's endpoint.
    // Alice (agent) drives the agent-only `agent/task/request`; the app client
    // does the membership mutations. Neither agent (`alice` nor `bob`) can
    // call the app-only admin RPCs — the gate rejects the non-app arm.
    const registered = yield* registerApp(
      baseUrl,
      TASK_MANAGER_MANIFEST,
      REGISTRATION_SECRET,
    );
    const appClient = yield* connectAppClient(
      registered.appId,
      registered.appKey,
      acceptTaskCreateHandlers(),
    );
    const created = yield* aliceClient.sendRpc(TaskRequest, {
      appId: registered.appId,
      invitedAgentIds: [],
    });

    const added = yield* appClient.sendRpc(TaskUpdate, {
      action: "add-participant",
      taskId: created.task.id,
      agentId: agentId(bobAgentId),
    });
    if (added.action !== "participant-added") {
      expect.fail("expected participant-added result");
    }
    expect(added.participant.agentId).toBe(bobAgentId);

    const removed = yield* appClient.sendRpc(TaskUpdate, {
      action: "remove-participant",
      taskId: created.task.id,
      agentId: agentId(bobAgentId),
    });
    if (removed.action !== "participant-removed") {
      expect.fail("expected participant-removed result");
    }

    const closed = yield* appClient.sendRpc(TaskUpdate, {
      action: "close",
      taskId: created.task.id,
    });
    if (closed.action !== "closed") {
      expect.fail("expected closed result");
    }
    expect(closed.task.status).toBe(CLOSED_STATUS);
  }));

it("task/list scopes results to caller-as-participant", () =>
  Effect.gen(function* () {
    const { aliceClient, bobClient } = yield* setupAliceAndBob();
    const aliceTask = yield* aliceClient.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [],
    });
    yield* bobClient.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [],
    });

    const aliceList = yield* aliceClient.sendRpc(TaskList, {});
    expect(aliceList.tasks.map((t) => t.id)).toContain(aliceTask.task.id);
    expect(aliceList.tasks).toHaveLength(1);
  }));
