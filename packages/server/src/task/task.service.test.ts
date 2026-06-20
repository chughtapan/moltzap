import { it as effectIt } from "@effect/vitest";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { Cause, Effect, Exit } from "effect";
import {
  agentId,
  appId as makeAppId,
  taskId as makeTaskId,
  userId,
  WIRE_ERROR_TAG,
} from "@moltzap/protocol/testing";
import { TaskService } from "./task.service.js";
import type { ConversationService } from "#conversation";
import type { MessageService } from "#message";
import {
  makePgliteHarness,
  PGLITE_HOOK_TIMEOUT_MS,
  type PgliteHarness,
} from "../test-utils/pglite-harness.js";

// Lifecycle + authority methods never invoke these deps; the conversation
// + message paths are covered by integration tests.
const STUB_CONV = {} as ConversationService;
const STUB_MSG = {} as MessageService;

const ALICE = agentId("00000000-0000-4000-8000-00000000a11c");
const BOB = agentId("00000000-0000-4000-8000-00000000b0b0");
const CAROL = agentId("00000000-0000-4000-8000-00000000ca20");
const ALICE_OWNER = userId("00000000-0000-4000-8000-00000001a11c");
const BOB_OWNER = userId("00000000-0000-4000-8000-00000001b0b0");
const CAROL_OWNER = userId("00000000-0000-4000-8000-00000001ca20");
const AGENTS = [
  {
    id: ALICE,
    name: "alice",
    owner_user_id: ALICE_OWNER,
    api_key_id: "0123456789abcdef",
    api_key_secret_hash:
      "0000000000000000000000000000000000000000000000000000000000000000",
    status: "active",
  },
  {
    id: BOB,
    name: "bob",
    owner_user_id: BOB_OWNER,
    api_key_id: "fedcba9876543210",
    api_key_secret_hash:
      "1111111111111111111111111111111111111111111111111111111111111111",
    status: "active",
  },
  {
    id: CAROL,
    name: "carol",
    owner_user_id: CAROL_OWNER,
    api_key_id: "aaaaaaaaaaaaaaaa",
    api_key_secret_hash:
      "2222222222222222222222222222222222222222222222222222222222222222",
    status: "active",
  },
] as const;
const TASK_STATUS_WAITING = "waiting";
const TASK_STATUS_CLOSED = "closed";
const UNKNOWN_TASK_ID = makeTaskId("00000000-0000-4000-8000-deadbeefcafe");

const ALICE_APP_ID = makeAppId("00000000-0000-4000-8000-0000000a11ce");
const BOB_APP_ID = makeAppId("00000000-0000-4000-8000-00000000b0b0");

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

function rpcFailureTag(exit: Exit.Exit<unknown, unknown>): string | null {
  if (Exit.isSuccess(exit)) return null;
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "None") return null;
  const v = failure.value;
  if (typeof v !== "object" || v === null) return null;
  const tag = (v as { readonly _tag?: unknown })._tag;
  return typeof tag === "string" ? tag : null;
}

// Task-admin service methods cover mutation mechanics. App-ownership is
// enforced by the app-arm handler through `assertCallerAppOwnsTask`, and the
// service-level open-status gate is `loadOpenTask`.

function createsWaitingTask() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, { appId: ALICE_APP_ID });
    expect(task.status).toBe(TASK_STATUS_WAITING);
    expect(task.initiatorAgentId).toBe(ALICE);
    expect(task.appId).toBe(ALICE_APP_ID);

    const view = yield* svc.get(task.id, ALICE);
    expect(view.task.id).toBe(task.id);
    expect(view.participants).toHaveLength(1);
    expect(view.participants[0]?.agentId).toBe(ALICE);
    expect(view.participants[0]?.admittedAt).not.toBeNull();
  });
}

function admitsInitiatorAndInvitedParticipants() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, {
      appId: ALICE_APP_ID,
      invitedAgentIds: [BOB],
    });
    const view = yield* svc.get(task.id, ALICE);
    const bobRow = view.participants.find((p) => p.agentId === BOB);
    expect(bobRow).toBeDefined();
    // TaskRequest auto-admits invitees; pending rows are exercised explicitly
    // by the read-gate test below.
    expect(bobRow?.admittedAt).not.toBeNull();
  });
}

function scopesListToCallerTasks() {
  return Effect.gen(function* () {
    const svc = makeService();
    const aliceTask = yield* svc.create(ALICE, { appId: ALICE_APP_ID });
    yield* svc.create(BOB, { appId: BOB_APP_ID });

    const aliceList = yield* svc.list(ALICE, {});
    expect(aliceList.tasks.map((t) => t.id)).toContain(aliceTask.id);
    expect(aliceList.tasks).toHaveLength(1);

    const carolList = yield* svc.list(CAROL, {});
    expect(carolList.tasks).toHaveLength(0);
  });
}

const SUB_MS_TASK_IDS = [
  makeTaskId("00000000-0000-4000-8000-00000000aa01"),
  makeTaskId("00000000-0000-4000-8000-00000000aa02"),
  makeTaskId("00000000-0000-4000-8000-00000000aa03"),
  makeTaskId("00000000-0000-4000-8000-00000000aa04"),
] as const;

// Three tasks share the same millisecond but differ in microseconds; a
// fourth sits in a later millisecond. Postgres stores microsecond
// precision but the cursor sortKey is millisecond-resolution (JS Date).
// A keyset that compares the full-precision column against the truncated
// cursor would skip the same-millisecond siblings on page 2 — this seeds
// exactly that condition.
function seedSubMillisecondTasks() {
  const sameMs = "2026-05-24T00:00:00.500";
  const rows = [
    { id: SUB_MS_TASK_IDS[0], created_at: `${sameMs}123Z` },
    { id: SUB_MS_TASK_IDS[1], created_at: `${sameMs}456Z` },
    { id: SUB_MS_TASK_IDS[2], created_at: `${sameMs}789Z` },
    { id: SUB_MS_TASK_IDS[3], created_at: "2026-05-24T00:00:00.600000Z" },
  ];
  return Effect.gen(function* () {
    for (const row of rows) {
      yield* harness.db.insertInto("tasks").values({
        id: row.id,
        app_id: ALICE_APP_ID,
        initiator_agent_id: ALICE,
        status: "active",
        created_at: row.created_at,
      });
      yield* harness.db.insertInto("task_participants").values({
        task_id: row.id,
        agent_id: ALICE,
        admitted_at: new Date(),
      });
    }
  });
}

// Walk every page with limit 1; assert each seeded task appears exactly
// once across pages (no skip, no dup) even when rows share a millisecond.
function paginatesSubMillisecondTiesWithoutSkips() {
  return Effect.gen(function* () {
    const svc = makeService();
    yield* seedSubMillisecondTasks();

    const seen: string[] = [];
    let cursor: string | undefined;
    let more = true;
    for (let guard = 0; more && guard < SUB_MS_TASK_IDS.length + 2; guard++) {
      const page = yield* svc.list(ALICE, { limit: 1, cursor });
      for (const task of page.tasks) seen.push(task.id);
      cursor = page.nextCursor;
      more = page.nextCursor !== undefined && page.tasks.length > 0;
    }

    expect([...seen].sort()).toEqual([...SUB_MS_TASK_IDS].sort());
    expect(new Set(seen).size).toBe(SUB_MS_TASK_IDS.length);
  });
}

function rejectsGetForNonParticipant() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, { appId: ALICE_APP_ID });
    const exit = yield* Effect.exit(svc.get(task.id, BOB));
    expect(rpcFailureTag(exit)).toBe(WIRE_ERROR_TAG.Forbidden);
  });
}

function rejectsUnknownTaskGet() {
  return Effect.gen(function* () {
    const svc = makeService();
    const exit = yield* Effect.exit(svc.get(UNKNOWN_TASK_ID, ALICE));
    expect(rpcFailureTag(exit)).toBe(WIRE_ERROR_TAG.TaskNotFound);
  });
}

function closesTask() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, { appId: ALICE_APP_ID });
    const closed = yield* svc.close(task.id);
    expect(closed.status).toBe(TASK_STATUS_CLOSED);
    expect(closed.endedAt).not.toBeNull();
  });
}

function addsParticipant() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, { appId: ALICE_APP_ID });
    const participant = yield* svc.addParticipant(task.id, CAROL);
    expect(participant.agentId).toBe(CAROL);
    expect(participant.admittedAt).not.toBeNull();
  });
}

function removesParticipant() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, {
      appId: ALICE_APP_ID,
      invitedAgentIds: [BOB],
    });
    yield* svc.removeParticipant(task.id, BOB);
    const view = yield* svc.get(task.id, ALICE);
    expect(view.participants.find((p) => p.agentId === BOB)).toBeUndefined();
  });
}

// The app-arm handler runs `loadOpenTask` before any mutation, so a closed task
// is rejected at the handler boundary.
function loadOpenTaskRejectsAfterClose() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, { appId: ALICE_APP_ID });
    yield* svc.close(task.id);
    const exit = yield* Effect.exit(svc.loadOpenTask(task.id));
    expect(rpcFailureTag(exit)).toBe(WIRE_ERROR_TAG.Forbidden);
  });
}

function deniesReadAccessToPendingInvitee() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, {
      appId: ALICE_APP_ID,
      invitedAgentIds: [BOB],
    });
    // Force BOB back into pending (admitted_at IS NULL) to exercise the read
    // gate independently of TaskRequest's auto-admit behavior.
    yield* harness.db
      .updateTable("task_participants")
      .set({ admitted_at: null })
      .where("task_id", "=", task.id)
      .where("agent_id", "=", BOB);
    const exit = yield* Effect.exit(svc.get(task.id, BOB));
    expect(rpcFailureTag(exit)).toBe(WIRE_ERROR_TAG.Forbidden);
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
      "admits initiator AND invited participants on create",
      admitsInitiatorAndInvitedParticipants,
    );
    it("scopes list to caller's tasks", scopesListToCallerTasks);
    it(
      "paginates sub-millisecond created_at ties without skips or dups",
      paginatesSubMillisecondTiesWithoutSkips,
    );
    it(
      "rejects get when caller is neither initiator nor participant",
      rejectsGetForNonParticipant,
    );
    it("404s on get of unknown taskId", rejectsUnknownTaskGet);
  });
}

function registerTaskAdminTests() {
  describe("task-admin mutations (unguarded service layer)", () => {
    it("close: transitions task to closed", closesTask);
    it("addParticipant: admits the target agent", addsParticipant);
    it("removeParticipant: drops the target agent", removesParticipant);
  });
}

function registerClosedTaskTests() {
  describe("closed-task open-status gate (loadOpenTask)", () => {
    it(
      "loadOpenTask rejects a closed task with ForbiddenError",
      loadOpenTaskRejectsAfterClose,
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
  });
}

describe("TaskService", () => {
  beforeEach(() => Effect.runPromise(setupHarness()), PGLITE_HOOK_TIMEOUT_MS);
  afterEach(() => Effect.runPromise(harness.close), PGLITE_HOOK_TIMEOUT_MS);

  registerCreateReadListTests();
  registerTaskAdminTests();
  registerClosedTaskTests();
  registerPendingInviteeTests();
  registerLoadOpenTaskTests();
});
