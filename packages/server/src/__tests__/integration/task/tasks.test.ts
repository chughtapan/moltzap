import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  TaskCreate,
  DEFAULT_APP_ID,
  TaskAddParticipant,
  TaskClose,
  TaskRequest,
  TaskList,
  TaskRemoveParticipant,
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

const REGISTRATION_SECRET = "tasks-test-secret-mnop";
const ALICE_USER_ID = "00000000-0000-4000-8000-00000000a11d";
const BOB_USER_ID = "00000000-0000-4000-8000-00000000b0b1";
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
    aliceClient: ServerTestClient;
    bobClient: ServerTestClient;
    aliceAgentId: string;
    bobAgentId: string;
  },
  Error
> {
  return Effect.gen(function* () {
    const idx = ++pairCounter;
    const aliceReg = yield* adminRegisterAgent({
      baseUrl,
      inviteCode: REGISTRATION_SECRET,
      name: `alice-tasks-${idx}`,
      ownerUserId: ALICE_USER_ID,
    });
    const bobReg = yield* adminRegisterAgent({
      baseUrl,
      inviteCode: REGISTRATION_SECRET,
      name: `bob-tasks-${idx}`,
      ownerUserId: BOB_USER_ID,
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
    const { aliceClient, bobClient, bobAgentId } = yield* setupAliceAndBob();
    // D #705 CP9 — TM-admin RPCs (`task/close`, `task/addParticipant`,
    // `task/removeParticipant`) are `callablePrincipal: "app"`. The
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
      },
      REGISTRATION_SECRET,
    );
    const appClient = yield* connectAppClient(registered.appKey);
    trackClient(appClient);
    yield* appClient.onAppCallback(TaskCreate, () =>
      Effect.succeed({ verdict: { decision: "accept" as const } }),
    );
    const created = yield* aliceClient.sendRpc(TaskRequest, {
      appId: registered.appId,
      invitedAgentIds: [],
    });

    // Bob (an agent, not the app principal) cannot mutate membership.
    const closeDenied = yield* Effect.either(
      bobClient.sendRpc(TaskClose, { taskId: created.task.id }),
    );
    expect(expectEitherLeft(closeDenied)).toBeDefined();

    const addDenied = yield* Effect.either(
      bobClient.sendRpc(TaskAddParticipant, {
        taskId: created.task.id,
        agentId: bobAgentId,
      }),
    );
    expect(expectEitherLeft(addDenied)).toBeDefined();

    // The app principal can.
    const added = yield* appClient.sendRpc(TaskAddParticipant, {
      taskId: created.task.id,
      agentId: bobAgentId,
    });
    expect(added.participant.agentId).toBe(bobAgentId);

    yield* appClient.sendRpc(TaskRemoveParticipant, {
      taskId: created.task.id,
      agentId: bobAgentId,
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
