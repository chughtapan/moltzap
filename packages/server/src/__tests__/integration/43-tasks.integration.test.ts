import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Either } from "effect";
import {
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

/**
 * Phase 9b consumer-migration (sub-issue #460 round 3 R13): atomic
 * `tasks/create` requires `tmEndpointAddress`. Custom-TM callers
 * (werewolf, this test) pass `tm:agent:<callerAgentId>` so the TM IS
 * the caller (matching the address `endpoints/registerTaskManager`
 * used to derive). The deleted `endpoints/*` wire RPCs no longer
 * appear in this suite.
 */
function selfTmAddress(agentId: string): string {
  return `tm:agent:${agentId}`;
}

describe("tasks/* RPC end-to-end (Phase 6 + Phase 9b round 3)", () => {
  it.live(
    "tasks/create returns a waiting task with the caller as initiator and the requested TM bound",
    () =>
      Effect.gen(function* () {
        const { aliceClient, aliceAgentId } = yield* setupAliceAndBob();
        const result = yield* aliceClient.sendRpc(TasksCreate, {
          tmEndpointAddress: selfTmAddress(aliceAgentId),
        });
        expect(result.task.status).toBe("waiting");
        expect(result.task.initiatorAgentId).toBe(aliceAgentId);
        // Phase 9b round 3 R12: NOT NULL by construction; the address
        // matches the request.
        expect(result.task.tmEndpointAddress).toBe(selfTmAddress(aliceAgentId));
      }),
  );

  it.live(
    "tasks/get rejects callers who are neither initiator nor participant",
    () =>
      Effect.gen(function* () {
        const { aliceClient, aliceAgentId, bobClient } =
          yield* setupAliceAndBob();
        const created = yield* aliceClient.sendRpc(TasksCreate, {
          tmEndpointAddress: selfTmAddress(aliceAgentId),
        });
        const result = yield* Effect.either(
          bobClient.sendRpc(TasksGet, { taskId: created.task.id }),
        );
        expect(Either.isLeft(result)).toBe(true);
      }),
  );

  it.live(
    "TM authority: only the registered TM may close, addParticipant, removeParticipant",
    () =>
      Effect.gen(function* () {
        const { aliceClient, aliceAgentId, bobClient, bobAgentId } =
          yield* setupAliceAndBob();
        const created = yield* aliceClient.sendRpc(TasksCreate, {
          tmEndpointAddress: selfTmAddress(aliceAgentId),
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
      const { aliceClient, aliceAgentId, bobClient, bobAgentId } =
        yield* setupAliceAndBob();
      const aliceTask = yield* aliceClient.sendRpc(TasksCreate, {
        tmEndpointAddress: selfTmAddress(aliceAgentId),
      });
      yield* bobClient.sendRpc(TasksCreate, {
        tmEndpointAddress: selfTmAddress(bobAgentId),
      });

      const aliceList = yield* aliceClient.sendRpc(TasksList, {});
      expect(aliceList.tasks.map((t) => t.id)).toContain(aliceTask.task.id);
      expect(aliceList.tasks).toHaveLength(1);
    }),
  );

  it.live(
    "tasks/create rejects malformed tmEndpointAddress at the boundary",
    () =>
      // Phase 9b round 3 R13: the handler brand-decodes
      // `tmEndpointAddress` via `endpointAddress(...)`; non-`tm:` shapes
      // fail with `invalidParams`. Pins the schema-level minLength + the
      // brand predicate together so a future tweak that loosens either
      // doesn't silently let `tm://foreign/addr` through.
      Effect.gen(function* () {
        const { aliceClient } = yield* setupAliceAndBob();
        const denied = yield* Effect.either(
          aliceClient.sendRpc(TasksCreate, {
            tmEndpointAddress: "tm://foreign/addr",
          }),
        );
        expect(Either.isLeft(denied)).toBe(true);
      }),
  );
});
