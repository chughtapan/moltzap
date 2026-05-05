import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Either } from "effect";
import {
  EndpointsRegisterTaskManager,
  EndpointsUnregisterTaskManager,
  TasksAddParticipant,
  TasksClose,
  TasksCreate,
  TasksGet,
  TasksList,
  TasksRemoveParticipant,
  type Task,
} from "@moltzap/protocol";
import {
  startTestServer,
  stopTestServer,
  resetTestDb,
  trackClient,
  connectTestClient,
  type ServerTestClient,
} from "./helpers.js";

const REGISTRATION_SECRET = "tasks-test-secret-mnop";
const ALICE_USER_ID = "00000000-0000-4000-8000-00000000a11d";
const BOB_USER_ID = "00000000-0000-4000-8000-00000000b0b1";

let baseUrl: string;
let wsUrl: string;
let pairCounter = 0;

beforeAll(async () => {
  const server = await startTestServer({
    registrationSecret: REGISTRATION_SECRET,
  });
  baseUrl = server.baseUrl;
  wsUrl = server.wsUrl;
}, 60_000);

afterAll(async () => {
  await stopTestServer();
});

beforeEach(async () => {
  await resetTestDb();
  pairCounter = 0;
});

interface AdminRegisterResponse {
  agentId: string;
  apiKey: string;
}

async function adminRegister(
  name: string,
  ownerUserId: string,
): Promise<AdminRegisterResponse> {
  const res = await fetch(`${baseUrl}/api/v1/admin/register-agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      inviteCode: REGISTRATION_SECRET,
      ownerUserId,
    }),
  });
  const json = (await res.json()) as AdminRegisterResponse;
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(
      `admin register failed: ${res.status} ${JSON.stringify(json)}`,
    );
  }
  return json;
}

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
    const aliceReg = yield* Effect.tryPromise(() =>
      adminRegister(`alice-tasks-${idx}`, ALICE_USER_ID),
    );
    const bobReg = yield* Effect.tryPromise(() =>
      adminRegister(`bob-tasks-${idx}`, BOB_USER_ID),
    );
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

describe("tasks/* + endpoints/* RPC end-to-end (Phase 6)", () => {
  it.live(
    "tasks/create returns a waiting task with the caller as initiator",
    () =>
      Effect.gen(function* () {
        const { aliceClient, aliceAgentId } = yield* setupAliceAndBob();
        const result = yield* aliceClient.sendRpc(TasksCreate, {});
        expect(result.task.status).toBe("waiting");
        expect(result.task.initiatorAgentId).toBe(aliceAgentId);
        expect(result.task.tmEndpointAddress).toBeNull();
      }),
  );

  it.live(
    "tasks/get rejects callers who are neither initiator nor participant",
    () =>
      Effect.gen(function* () {
        const { aliceClient, bobClient } = yield* setupAliceAndBob();
        const created = yield* aliceClient.sendRpc(TasksCreate, {});
        const result = yield* Effect.either(
          bobClient.sendRpc(TasksGet, { taskId: created.task.id }),
        );
        expect(Either.isLeft(result)).toBe(true);
      }),
  );

  it.live(
    "endpoints/registerTaskManager records caller-derived address; non-initiator rejected",
    () =>
      Effect.gen(function* () {
        const { aliceClient, bobClient } = yield* setupAliceAndBob();
        const created = yield* aliceClient.sendRpc(TasksCreate, {});

        // Bob (non-initiator) is rejected with Forbidden.
        const denied = yield* Effect.either(
          bobClient.sendRpc(EndpointsRegisterTaskManager, {
            taskId: created.task.id,
          }),
        );
        expect(Either.isLeft(denied)).toBe(true);

        // Alice (initiator) succeeds; address is non-empty.
        const ok = yield* aliceClient.sendRpc(EndpointsRegisterTaskManager, {
          taskId: created.task.id,
        });
        expect(ok.taskId).toBe(created.task.id);
        expect(ok.tmEndpointAddress.length).toBeGreaterThan(0);

        // Re-register by Alice is idempotent.
        const second = yield* aliceClient.sendRpc(
          EndpointsRegisterTaskManager,
          { taskId: created.task.id },
        );
        expect(second.tmEndpointAddress).toBe(ok.tmEndpointAddress);
      }),
  );

  it.live(
    "TM authority: only the registered TM may close, addParticipant, removeParticipant",
    () =>
      Effect.gen(function* () {
        const { aliceClient, bobClient, bobAgentId } =
          yield* setupAliceAndBob();
        const created = yield* aliceClient.sendRpc(TasksCreate, {});
        yield* aliceClient.sendRpc(EndpointsRegisterTaskManager, {
          taskId: created.task.id,
        });

        // Bob (not the TM) cannot mutate.
        const closeDenied = yield* Effect.either(
          bobClient.sendRpc(TasksClose, { taskId: created.task.id }),
        );
        expect(Either.isLeft(closeDenied)).toBe(true);

        const addDenied = yield* Effect.either(
          bobClient.sendRpc(TasksAddParticipant, {
            taskId: created.task.id,
            agentId: bobAgentId as Task["initiatorAgentId"],
          }),
        );
        expect(Either.isLeft(addDenied)).toBe(true);

        // Alice (the TM) can.
        const added = yield* aliceClient.sendRpc(TasksAddParticipant, {
          taskId: created.task.id,
          agentId: bobAgentId as Task["initiatorAgentId"],
        });
        expect(added.participant.agentId).toBe(bobAgentId);

        // Now Bob is a participant — get works.
        const getView = yield* bobClient.sendRpc(TasksGet, {
          taskId: created.task.id,
        });
        expect(getView.participants.length).toBe(2);

        // Alice (TM) removes.
        yield* aliceClient.sendRpc(TasksRemoveParticipant, {
          taskId: created.task.id,
          agentId: bobAgentId as Task["initiatorAgentId"],
        });

        // Alice (TM) closes.
        const closed = yield* aliceClient.sendRpc(TasksClose, {
          taskId: created.task.id,
        });
        expect(closed.task.status).toBe("closed");
      }),
  );

  it.live("tasks/list scopes results to caller-as-participant", () =>
    Effect.gen(function* () {
      const { aliceClient, bobClient } = yield* setupAliceAndBob();
      const aliceTask = yield* aliceClient.sendRpc(TasksCreate, {});
      yield* bobClient.sendRpc(TasksCreate, {});

      const aliceList = yield* aliceClient.sendRpc(TasksList, {});
      expect(aliceList.tasks.map((t) => t.id)).toContain(aliceTask.task.id);
      expect(aliceList.tasks).toHaveLength(1);
    }),
  );

  it.live(
    "endpoints/unregisterTaskManager only callable by the registered TM",
    () =>
      Effect.gen(function* () {
        const { aliceClient, bobClient } = yield* setupAliceAndBob();
        const created = yield* aliceClient.sendRpc(TasksCreate, {});
        yield* aliceClient.sendRpc(EndpointsRegisterTaskManager, {
          taskId: created.task.id,
        });

        const denied = yield* Effect.either(
          bobClient.sendRpc(EndpointsUnregisterTaskManager, {
            taskId: created.task.id,
          }),
        );
        expect(Either.isLeft(denied)).toBe(true);

        yield* aliceClient.sendRpc(EndpointsUnregisterTaskManager, {
          taskId: created.task.id,
        });
        const view = yield* aliceClient.sendRpc(TasksGet, {
          taskId: created.task.id,
        });
        expect(view.task.tmEndpointAddress).toBeNull();
      }),
  );
});
