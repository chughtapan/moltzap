import { describe, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Either } from "effect";
import {
  InvalidParamsError,
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
 * Phase 9b consumer-migration (sub-issue #460 round 4 R16, codex
 * HIGH-A): the wire body carries `tmType` (a kind marker), not a raw
 * address. Custom-TM callers pass `tmType: "self"` so the server
 * derives `tm:agent:<callerAgentId>` from the authenticated caller —
 * the pre-R16 hole where caller A could pass
 * `tmEndpointAddress: "tm:agent:<B>"` is closed at the wire boundary.
 * The server-derived address is what `endpoints/registerTaskManager`
 * used to mint pre-R13.
 */
function expectSelfTmAddress(agentId: string): string {
  return `tm:agent:${agentId}`;
}

describe("tasks/* RPC end-to-end (Phase 6 + Phase 9b round 4)", () => {
  it.live(
    "tasks/create returns a waiting task with the caller as initiator and the server-derived self TM bound",
    () =>
      Effect.gen(function* () {
        const { aliceClient, aliceAgentId } = yield* setupAliceAndBob();
        const result = yield* aliceClient.sendRpc(TasksCreate, {
          tmType: "self",
        });
        expect(result.task.status).toBe("waiting");
        expect(result.task.initiatorAgentId).toBe(aliceAgentId);
        // Phase 9b round 4 R16: server derives the address from
        // ctx.agentId; matches the address the deleted
        // `endpoints/registerTaskManager` used to derive.
        expect(result.task.tmEndpointAddress).toBe(
          expectSelfTmAddress(aliceAgentId),
        );
      }),
  );

  it.live(
    "tasks/get rejects callers who are neither initiator nor participant",
    () =>
      Effect.gen(function* () {
        const { aliceClient, bobClient } = yield* setupAliceAndBob();
        const created = yield* aliceClient.sendRpc(TasksCreate, {
          tmType: "self",
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
        const { aliceClient, bobClient, bobAgentId } =
          yield* setupAliceAndBob();
        const created = yield* aliceClient.sendRpc(TasksCreate, {
          tmType: "self",
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
      const aliceTask = yield* aliceClient.sendRpc(TasksCreate, {
        tmType: "self",
      });
      yield* bobClient.sendRpc(TasksCreate, {
        tmType: "self",
      });

      const aliceList = yield* aliceClient.sendRpc(TasksList, {});
      expect(aliceList.tasks.map((t) => t.id)).toContain(aliceTask.task.id);
      expect(aliceList.tasks).toHaveLength(1);
    }),
  );

  // Prereq 2 (#525 §7) follow-up (#528): app-bound tasks must carry
  // their own moderator (the TM IS the app), so pairing an `appId`
  // with a `default-*` TM kind is rejected at the wire boundary with
  // `InvalidParamsError`. Implementation:
  // `task/handlers/tasks.handlers.ts:71-83`.
  it.live(
    "tasks/create rejects appId + default-dm with InvalidParamsError",
    () =>
      Effect.gen(function* () {
        const { aliceClient } = yield* setupAliceAndBob();
        const outcome = yield* Effect.either(
          aliceClient.sendRpc(TasksCreate, {
            appId: "some-app",
            tmType: "default-dm",
          }),
        );
        expect(Either.isLeft(outcome)).toBe(true);
        if (Either.isLeft(outcome)) {
          const err = outcome.left as { code?: number; message?: string };
          expect(err.code).toBe(InvalidParamsError.code);
          expect(err.message).toMatch(
            /app-bound tasks cannot use a default TM/i,
          );
        }
      }),
  );

  it.live(
    "tasks/create rejects appId + default-group with InvalidParamsError",
    () =>
      Effect.gen(function* () {
        const { aliceClient } = yield* setupAliceAndBob();
        const outcome = yield* Effect.either(
          aliceClient.sendRpc(TasksCreate, {
            appId: "some-app",
            tmType: "default-group",
          }),
        );
        expect(Either.isLeft(outcome)).toBe(true);
        if (Either.isLeft(outcome)) {
          const err = outcome.left as { code?: number; message?: string };
          expect(err.code).toBe(InvalidParamsError.code);
          expect(err.message).toMatch(
            /app-bound tasks cannot use a default TM/i,
          );
        }
      }),
  );

  // Positive control for the §7 rejection arm: `appId` paired with a
  // non-default TM kind (`self`) is the legitimate app-bound shape and
  // must succeed.
  it.live(
    "tasks/create accepts appId + tmType: self (positive control for §7 rejection arm)",
    () =>
      Effect.gen(function* () {
        const { aliceClient, aliceAgentId } = yield* setupAliceAndBob();
        const result = yield* aliceClient.sendRpc(TasksCreate, {
          appId: "some-app",
          tmType: "self",
        });
        expect(result.task.appId).toBe("some-app");
        expect(result.task.tmEndpointAddress).toBe(
          expectSelfTmAddress(aliceAgentId),
        );
      }),
  );

  it.live(
    "tasks/create cannot bind a stranger's TM (R16 codex HIGH-A guard)",
    () =>
      // Pre-R16 this scenario was the bug: caller A invokes
      // `tasks/create({ tmEndpointAddress: "tm:agent:<B>" })` and the
      // server happily wrote it. With `tmType` the wire body has no
      // path for caller-supplied addresses; `"self"` always derives
      // `tm:agent:<callerAgentId>`, never a stranger's id.
      Effect.gen(function* () {
        const { aliceClient, aliceAgentId, bobAgentId } =
          yield* setupAliceAndBob();
        const result = yield* aliceClient.sendRpc(TasksCreate, {
          tmType: "self",
        });
        // The persisted address belongs to the caller, regardless of
        // what bobAgentId looks like — there is no longer a wire
        // affordance to name another agent.
        expect(result.task.tmEndpointAddress).toBe(
          expectSelfTmAddress(aliceAgentId),
        );
        expect(result.task.tmEndpointAddress).not.toBe(
          expectSelfTmAddress(bobAgentId),
        );
      }),
  );
});
