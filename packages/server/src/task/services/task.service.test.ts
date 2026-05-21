import { it as effectIt } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { Cause, Effect, Exit, Layer } from "effect";
import { ForbiddenError, NotFoundError } from "@moltzap/protocol";
import {
  agentId,
  taskId as makeTaskId,
  wireErrorFromInstance,
} from "@moltzap/protocol/testing";
import type { TaskId } from "@moltzap/protocol/task";
import { TaskService } from "./task.service.js";
import type { ConversationService } from "./conversation.service.js";
import type { MessageService } from "./message.service.js";
import {
  makePgliteHarness,
  PGLITE_HOOK_TIMEOUT_MS,
  type PgliteHarness,
} from "../../test-utils/index.js";
import {
  TaskReadAccess,
  TmAuthority,
  obtainTaskReadAccess,
  obtainTmAuthority,
} from "../../app/capabilities/index.js";
import { AppHostTag, TaskServiceTag } from "../../app/layers.js";
import type { AppHost } from "../../app/app-host.js";
import type { AgentId } from "@moltzap/protocol/identity";

// Lifecycle + authority methods never invoke these deps; the conversation
// + message paths are covered by integration tests.
const STUB_CONV = {} as ConversationService;
const STUB_MSG = {} as MessageService;

const ALICE = agentId("00000000-0000-4000-8000-00000000a11c");
const BOB = agentId("00000000-0000-4000-8000-00000000b0b0");
const CAROL = agentId("00000000-0000-4000-8000-00000000ca20");
const AGENTS = [
  {
    id: ALICE,
    name: "alice",
    api_key_id: "0123456789abcdef",
    api_key_secret_hash:
      "0000000000000000000000000000000000000000000000000000000000000000",
    claim_token: "claim-alice",
    status: "active",
  },
  {
    id: BOB,
    name: "bob",
    api_key_id: "fedcba9876543210",
    api_key_secret_hash:
      "1111111111111111111111111111111111111111111111111111111111111111",
    claim_token: "claim-bob",
    status: "active",
  },
  {
    id: CAROL,
    name: "carol",
    api_key_id: "aaaaaaaaaaaaaaaa",
    api_key_secret_hash:
      "2222222222222222222222222222222222222222222222222222222222222222",
    claim_token: "claim-carol",
    status: "active",
  },
] as const;
const TASK_STATUS_WAITING = "waiting";
const TASK_STATUS_CLOSED = "closed";
const UNKNOWN_TASK_ID = makeTaskId("00000000-0000-4000-8000-deadbeefcafe");

const ALICE_APP_ID = "alice-app";
const BOB_APP_ID = "bob-app";
const ALICE_CONN = "alice-conn-1";
const BOB_CONN = "bob-conn-1";
const CAROL_CONN = "carol-conn-1";

let harness: PgliteHarness;

const it = effectIt.effect;

function setupHarness() {
  return makePgliteHarness().pipe(
    Effect.tap((created) =>
      Effect.sync(() => {
        harness = created;
      }),
    ),
    Effect.flatMap(seedAgents),
  );
}

function seedAgents() {
  return harness.db.insertInto("agents").values(AGENTS);
}

function makeService() {
  return new TaskService(harness.db, STUB_CONV, STUB_MSG);
}

/**
 * Minimal AppHost stub for capability tests: `isAppConnection(appId,
 * connId)` returns true iff `(appId, connId)` is in the seeded set.
 */
type AppHostStub = Pick<AppHost, "isAppConnection">;

function makeAppHostStub(
  bindings: ReadonlyArray<readonly [string, string]>,
): AppHost {
  const seeded = new Set(bindings.map(([app, conn]) => `${app}::${conn}`));
  const stub: AppHostStub = {
    isAppConnection: (appId, connId) => seeded.has(`${appId}::${connId}`),
  };
  return stub as AppHost;
}

function aliceAppLayer() {
  return Layer.succeed(
    AppHostTag,
    makeAppHostStub([[ALICE_APP_ID, ALICE_CONN]]),
  );
}

function rpcFailureCode(exit: Exit.Exit<unknown, unknown>): number | null {
  if (Exit.isSuccess(exit)) return null;
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "None") return null;
  return wireErrorFromInstance(failure.value)?.code ?? null;
}

function withTmAuth(
  taskId: TaskId,
  callerConnId: string,
  svc: TaskService,
  app: Layer.Layer<AppHostTag> = aliceAppLayer(),
) {
  return <A, E, R>(eff: Effect.Effect<A, E, R | TmAuthority>) =>
    eff.pipe(
      Effect.provideServiceEffect(
        TmAuthority,
        obtainTmAuthority(taskId, callerConnId),
      ),
      Effect.provideService(TaskServiceTag, svc),
      Effect.provide(app),
    ) as Effect.Effect<A, E, Exclude<R, TmAuthority | AppHostTag>>;
}

function withReadAccess(taskId: TaskId, caller: AgentId, svc: TaskService) {
  return <A, E, R>(eff: Effect.Effect<A, E, R | TaskReadAccess>) =>
    eff.pipe(
      Effect.provideServiceEffect(
        TaskReadAccess,
        obtainTaskReadAccess(taskId, caller),
      ),
      Effect.provideService(TaskServiceTag, svc),
    ) as Effect.Effect<A, E, Exclude<R, TaskReadAccess>>;
}

function createsWaitingTask() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, { appId: ALICE_APP_ID });
    expect(task.status).toBe(TASK_STATUS_WAITING);
    expect(task.initiatorAgentId).toBe(ALICE);
    expect(task.appId).toBe(ALICE_APP_ID);

    const view = yield* svc
      .get(task.id, ALICE)
      .pipe(withReadAccess(task.id, ALICE, svc));
    expect(view.task.id).toBe(task.id);
    expect(view.participants).toHaveLength(1);
    expect(view.participants[0]?.agentId).toBe(ALICE);
    expect(view.participants[0]?.admittedAt).not.toBeNull();
  });
}

function admitsInvitedParticipantAsPending() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, {
      appId: ALICE_APP_ID,
      invitedAgentIds: [BOB],
    });
    const view = yield* svc
      .get(task.id, ALICE)
      .pipe(withReadAccess(task.id, ALICE, svc));
    const bobRow = view.participants.find((p) => p.agentId === BOB);
    expect(bobRow).toBeDefined();
    expect(bobRow?.admittedAt).toBeNull();
  });
}

function scopesListToCallerTasks() {
  return Effect.gen(function* () {
    const svc = makeService();
    const aliceTask = yield* svc.create(ALICE, { appId: ALICE_APP_ID });
    yield* svc.create(BOB, { appId: BOB_APP_ID });

    const aliceList = yield* svc.list(ALICE, {});
    expect(aliceList.map((t) => t.id)).toContain(aliceTask.id);
    expect(aliceList).toHaveLength(1);

    const carolList = yield* svc.list(CAROL, {});
    expect(carolList).toHaveLength(0);
  });
}

function rejectsGetForNonParticipant() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, { appId: ALICE_APP_ID });
    const exit = yield* Effect.exit(
      svc.get(task.id, BOB).pipe(withReadAccess(task.id, BOB, svc)),
    );
    expect(rpcFailureCode(exit)).toBe(ForbiddenError.code);
  });
}

function rejectsUnknownTaskGet() {
  return Effect.gen(function* () {
    const svc = makeService();
    const exit = yield* Effect.exit(
      svc
        .get(UNKNOWN_TASK_ID, ALICE)
        .pipe(withReadAccess(UNKNOWN_TASK_ID, ALICE, svc)),
    );
    expect(rpcFailureCode(exit)).toBe(NotFoundError.code);
  });
}

function rejectsCloseFromNonTm() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, { appId: ALICE_APP_ID });
    const exit = yield* Effect.exit(
      svc.close(task.id, BOB).pipe(withTmAuth(task.id, BOB_CONN, svc)),
    );
    expect(rpcFailureCode(exit)).toBe(ForbiddenError.code);
  });
}

function closesTaskFromRegisteredTm() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, { appId: ALICE_APP_ID });
    const closed = yield* svc
      .close(task.id, ALICE)
      .pipe(withTmAuth(task.id, ALICE_CONN, svc));
    expect(closed.status).toBe(TASK_STATUS_CLOSED);
    expect(closed.endedAt).not.toBeNull();
  });
}

function restrictsAddParticipantToRegisteredTm() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, { appId: ALICE_APP_ID });

    const denied = yield* Effect.exit(
      svc
        .addParticipant(task.id, BOB, CAROL)
        .pipe(withTmAuth(task.id, BOB_CONN, svc)),
    );
    expect(rpcFailureCode(denied)).toBe(ForbiddenError.code);

    const participant = yield* svc
      .addParticipant(task.id, ALICE, CAROL)
      .pipe(withTmAuth(task.id, ALICE_CONN, svc));
    expect(participant.agentId).toBe(CAROL);
    expect(participant.admittedAt).not.toBeNull();
  });
}

function restrictsRemoveParticipantToRegisteredTm() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, {
      appId: ALICE_APP_ID,
      invitedAgentIds: [BOB],
    });

    const denied = yield* Effect.exit(
      svc
        .removeParticipant(task.id, CAROL, BOB)
        .pipe(withTmAuth(task.id, CAROL_CONN, svc)),
    );
    expect(rpcFailureCode(denied)).toBe(ForbiddenError.code);

    yield* svc
      .removeParticipant(task.id, ALICE, BOB)
      .pipe(withTmAuth(task.id, ALICE_CONN, svc));
    const view = yield* svc
      .get(task.id, ALICE)
      .pipe(withReadAccess(task.id, ALICE, svc));
    expect(view.participants.find((p) => p.agentId === BOB)).toBeUndefined();
  });
}

function rejectsMutationAfterClose() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, { appId: ALICE_APP_ID });
    yield* svc.close(task.id, ALICE).pipe(withTmAuth(task.id, ALICE_CONN, svc));

    const addExit = yield* Effect.exit(
      svc
        .addParticipant(task.id, ALICE, BOB)
        .pipe(withTmAuth(task.id, ALICE_CONN, svc)),
    );
    expect(rpcFailureCode(addExit)).toBe(ForbiddenError.code);

    const closeExit = yield* Effect.exit(
      svc.close(task.id, ALICE).pipe(withTmAuth(task.id, ALICE_CONN, svc)),
    );
    expect(rpcFailureCode(closeExit)).toBe(ForbiddenError.code);
  });
}

function deniesReadAccessToPendingInvitee() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, {
      appId: ALICE_APP_ID,
      invitedAgentIds: [BOB],
    });
    const exit = yield* Effect.exit(
      svc.get(task.id, BOB).pipe(withReadAccess(task.id, BOB, svc)),
    );
    expect(rpcFailureCode(exit)).toBe(ForbiddenError.code);
  });
}

function loadOpenTaskRejectsClosed() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, { appId: ALICE_APP_ID });
    yield* svc.close(task.id, ALICE).pipe(withTmAuth(task.id, ALICE_CONN, svc));
    const exit = yield* Effect.exit(svc.loadOpenTask(task.id));
    expect(rpcFailureCode(exit)).toBe(ForbiddenError.code);
  });
}

function loadOpenTaskOk() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, { appId: ALICE_APP_ID });
    const loaded = yield* svc.loadOpenTask(task.id);
    expect(loaded.id).toBe(task.id);
  });
}

function registerCreateReadListTests() {
  describe("create + get + list", () => {
    it(
      "creates a waiting task with the initiator auto-admitted and the bound app",
      createsWaitingTask,
    );
    it(
      "admits initiator and pre-creates pending invited participants",
      admitsInvitedParticipantAsPending,
    );
    it("scopes list to caller's tasks", scopesListToCallerTasks);
    it(
      "rejects get when caller is neither initiator nor participant",
      rejectsGetForNonParticipant,
    );
    it("404s on get of unknown taskId", rejectsUnknownTaskGet);
  });
}

function registerTmAuthorityTests() {
  describe("TmAuthority — app-ownership gate", () => {
    it(
      "close: rejects caller whose connection does not own the app",
      rejectsCloseFromNonTm,
    );
    it(
      "close: registered remote-app connection transitions task to closed",
      closesTaskFromRegisteredTm,
    );
    it(
      "addParticipant: only the registered app connection may add",
      restrictsAddParticipantToRegisteredTm,
    );
    it(
      "removeParticipant: only the registered app connection may remove",
      restrictsRemoveParticipantToRegisteredTm,
    );
  });
}

function registerClosedTaskTests() {
  describe("closed-task immutability", () => {
    it(
      "rejects mutations after close even by the registered TM",
      rejectsMutationAfterClose,
    );
  });
}

function registerPendingInviteeTests() {
  describe("read access denies pending invitees", () => {
    it(
      "admitted_at IS NULL means no read access",
      deniesReadAccessToPendingInvitee,
    );
  });
}

function registerLoadOpenTaskTests() {
  describe("loadOpenTask", () => {
    it("succeeds on waiting/active tasks", loadOpenTaskOk);
    it("rejects closed tasks with ForbiddenError", loadOpenTaskRejectsClosed);
  });
}

describe("TaskService", () => {
  beforeEach(() => Effect.runPromise(setupHarness()), PGLITE_HOOK_TIMEOUT_MS);
  afterEach(() => Effect.runPromise(harness.close), PGLITE_HOOK_TIMEOUT_MS);

  registerCreateReadListTests();
  registerTmAuthorityTests();
  registerClosedTaskTests();
  registerPendingInviteeTests();
  registerLoadOpenTaskTests();
});
