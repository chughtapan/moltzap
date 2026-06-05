import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import { DispatchAuthorize } from "@moltzap/protocol/dispatch";
import {
  DEFAULT_APP_ID,
  TaskAddParticipant,
  TaskClose,
  TaskCreate,
  TaskList,
  TaskRemoveParticipant,
  TaskRequest,
} from "@moltzap/protocol/task";
import { MessagesAuthorize } from "@moltzap/protocol/message";
import type {
  AppCallbackContext,
  AppCallbackHandlers,
} from "@moltzap/protocol/socket";
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
  registerClaimedAgent,
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
    const aliceReg = yield* registerClaimedAgent({
      baseUrl,
      inviteCode: REGISTRATION_SECRET,
      name: `alice-tasks-${idx}`,
      user: ALICE_USER,
    });
    const bobReg = yield* registerClaimedAgent({
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

it("task/request returns an active task bound to the supplied appId", () =>
  Effect.gen(function* () {
    const { aliceClient, aliceAgentId } = yield* setupAliceAndBob();
    const result = yield* aliceClient.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [],
    });
    // DEFAULT_APP auto-accepts the task/create TM callback → active.
    expect(result.task.status).toBe(ACTIVE_STATUS);
    expect(result.task.initiatorAgentId).toBe(aliceAgentId);
    expect(result.task.appId).toBe(DEFAULT_APP_ID);
  }));

it("TM authority: only the app principal may mutate task membership", () =>
  Effect.gen(function* () {
    const { aliceClient, bobAgentId } = yield* setupAliceAndBob();
    // TM-admin RPCs (`task/close`, `task/addParticipant`,
    // `task/removeParticipant`) head their `requires` with `AppPrincipal`. The
    // moderator is a SEPARATE app principal: it registers via HTTP, then
    // `appKey`-Connects to bind its `AppConnection` as the app's endpoint.
    // Alice (agent) drives the agent-only `task/request`; the app client
    // does the membership mutations. Neither agent (`alice` nor `bob`) can
    // call the app-only admin RPCs — the gate rejects the non-app arm.
    const registered = yield* registerApp(
      baseUrl,
      {
        appId: "00000000-0000-4000-8000-000000010007",
        name: "tm-test-app",
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
    const appClient = yield* connectAppClient(
      registered.appId,
      registered.appKey,
      acceptTaskCreateHandlers(),
    );
    const created = yield* aliceClient.sendRpc(TaskRequest, {
      appId: registered.appId,
      invitedAgentIds: [],
    });

    const added = yield* appClient.sendRpc(TaskAddParticipant, {
      taskId: created.task.id,
      agentId: agentId(bobAgentId),
    });
    expect(added.participant.agentId).toBe(bobAgentId);

    yield* appClient.sendRpc(TaskRemoveParticipant, {
      taskId: created.task.id,
      agentId: agentId(bobAgentId),
    });

    const closed = yield* appClient.sendRpc(TaskClose, {
      taskId: created.task.id,
    });
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
