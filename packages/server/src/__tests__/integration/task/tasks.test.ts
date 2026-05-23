import { expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Effect } from "effect";
import {
  AppsRegister,
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
  adminRegisterAgent,
  expectEitherLeft,
  type ServerTestClient,
} from "../helpers.js";

const REGISTRATION_SECRET = "tasks-test-secret-mnop";
const ALICE_USER_ID = "00000000-0000-4000-8000-00000000a11d";
const BOB_USER_ID = "00000000-0000-4000-8000-00000000b0b1";
const WAITING_STATUS = "waiting";
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

it("task/create returns a waiting task bound to the supplied appId", () =>
  Effect.gen(function* () {
    const { aliceClient, aliceAgentId } = yield* setupAliceAndBob();
    const result = yield* aliceClient.sendRpc(TaskRequest, {
      appId: DEFAULT_APP_ID,
      invitedAgentIds: [],
    });
    expect(result.task.status).toBe(WAITING_STATUS);
    expect(result.task.initiatorAgentId).toBe(aliceAgentId);
    expect(result.task.appId).toBe(DEFAULT_APP_ID);
  }));

it("TM authority: only the registered app connection may mutate task membership", () =>
  Effect.gen(function* () {
    const { aliceClient, bobClient, bobAgentId } = yield* setupAliceAndBob();
    // TM authority is proved via app-ownership of the calling WS
    // connection. Alice AppsRegisters a custom app; her connection
    // becomes the remote-app entry for TM_TEST_APP_ID. Bob does not
    // register, so his connection cannot pass TM-authority. (A
    // DEFAULT_APP_ID AppsRegister would return ForbiddenError — that
    // app is boot-installed and unhijackable.)
    const TM_TEST_APP_ID =
      "00000000-0000-4000-8000-000000010007" as typeof DEFAULT_APP_ID;
    yield* aliceClient.sendRpc(AppsRegister, {
      manifest: {
        appId: TM_TEST_APP_ID,
        name: "tm-test-app",
      },
    });
    const created = yield* aliceClient.sendRpc(TaskRequest, {
      appId: TM_TEST_APP_ID,
      invitedAgentIds: [],
    });

    // Bob (not the registered app connection) cannot mutate.
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

    // Alice (the registered app connection) can.
    const added = yield* aliceClient.sendRpc(TaskAddParticipant, {
      taskId: created.task.id,
      agentId: bobAgentId,
    });
    expect(added.participant.agentId).toBe(bobAgentId);

    yield* aliceClient.sendRpc(TaskRemoveParticipant, {
      taskId: created.task.id,
      agentId: bobAgentId,
    });

    const closed = yield* aliceClient.sendRpc(TaskClose, {
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
