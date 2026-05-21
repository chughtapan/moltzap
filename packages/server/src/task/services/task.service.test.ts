import { it as effectIt } from "@effect/vitest";
import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { Cause, Effect, Exit } from "effect";
import { ForbiddenError, NotFoundError } from "@moltzap/protocol";
import {
  agentId,
  taskId as makeTaskId,
  wireErrorFromInstance,
} from "@moltzap/protocol/testing";
import type { TaskId } from "@moltzap/protocol/task";
import { TaskService, endpointAddressForAgent } from "./task.service.js";
import type { ConversationService } from "./conversation.service.js";
import type { MessageService } from "./message.service.js";
import {
  makePgliteHarness,
  PGLITE_HOOK_TIMEOUT_MS,
  type PgliteHarness,
} from "../../test-utils/index.js";
import { TaskReadAccess, TmAuthority } from "@moltzap/protocol/task";
import { serverCapabilityProviders } from "../../app/capability-providers.js";
import { TaskServiceTag } from "../../app/layers.js";
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
const KNOWN_AGENTS = [ALICE, BOB, CAROL] as const;
const NON_ALICE_AGENTS = [BOB, CAROL] as const;
const PROPERTY_RUNS = 8;
const TASK_STATUS_WAITING = "waiting";
const TASK_STATUS_CLOSED = "closed";
const TM_APP_ADDRESS_PATTERN = /^tm:app:/;
const UNKNOWN_TASK_ID = makeTaskId("00000000-0000-4000-8000-deadbeefcafe");
const FOREIGN_TM_ENDPOINT = "tm://foreign/addr-1";
const EMPTY_TM_ENDPOINT = "";

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

function aliceAsTm() {
  return {
    tmEndpointAddress: endpointAddressForAgent(ALICE),
  };
}

function rpcFailureCode(exit: Exit.Exit<unknown, unknown>): number | null {
  if (Exit.isSuccess(exit)) return null;
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "None") return null;
  return wireErrorFromInstance(failure.value)?.code ?? null;
}

function withTmAuth(taskId: TaskId, caller: AgentId, svc: TaskService) {
  return <A, E, R>(eff: Effect.Effect<A, E, R | TmAuthority>) =>
    eff.pipe(
      Effect.provideServiceEffect(
        TmAuthority,
        serverCapabilityProviders[TmAuthority.key]({
          taskId,
          callerAgentId: caller,
        }) as Effect.Effect<never, unknown, TaskServiceTag>,
      ),
      Effect.provideService(TaskServiceTag, svc),
    ) as Effect.Effect<A, E, Exclude<R, TmAuthority>>;
}

function withReadAccess(taskId: TaskId, caller: AgentId, svc: TaskService) {
  return <A, E, R>(eff: Effect.Effect<A, E, R | TaskReadAccess>) =>
    eff.pipe(
      Effect.provideServiceEffect(
        TaskReadAccess,
        serverCapabilityProviders[TaskReadAccess.key]({
          taskId,
          callerAgentId: caller,
        }) as Effect.Effect<never, unknown, TaskServiceTag>,
      ),
      Effect.provideService(TaskServiceTag, svc),
    ) as Effect.Effect<A, E, Exclude<R, TaskReadAccess>>;
}

function setPersistedTmEndpoint(id: TaskId, address: string) {
  return harness.db
    .updateTable("tasks")
    .set({ tm_endpoint_address: address })
    .where("id", "=", id);
}

function knownAgentEndpointMatches(agent: (typeof KNOWN_AGENTS)[number]) {
  expect(endpointAddressForAgent(agent)).toBe(`tm:agent:${agent}`);
}

function nonAliceEndpointDiffers(agent: (typeof NON_ALICE_AGENTS)[number]) {
  expect(endpointAddressForAgent(agent)).not.toBe(
    endpointAddressForAgent(ALICE),
  );
}

function endpointAddressProperty() {
  return Effect.sync(() => {
    fc.assert(
      fc.property(fc.constantFrom(...KNOWN_AGENTS), knownAgentEndpointMatches),
      {
        numRuns: PROPERTY_RUNS,
      },
    );
  });
}

function nonTmEndpointProperty() {
  return Effect.sync(() => {
    fc.assert(
      fc.property(
        fc.constantFrom(...NON_ALICE_AGENTS),
        nonAliceEndpointDiffers,
      ),
      {
        numRuns: PROPERTY_RUNS,
      },
    );
  });
}

function createsWaitingTask() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, aliceAsTm());
    expect(task.status).toBe(TASK_STATUS_WAITING);
    expect(task.initiatorAgentId).toBe(ALICE);
    expect(task.tmEndpointAddress).toBe(endpointAddressForAgent(ALICE));

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
      ...aliceAsTm(),
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
    const aliceTask = yield* svc.create(ALICE, aliceAsTm());
    yield* svc.create(BOB, { tmEndpointAddress: endpointAddressForAgent(BOB) });

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
    const task = yield* svc.create(ALICE, aliceAsTm());
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

function bindsDefaultDmTmAddress() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.createDefaultTaskForType("dm", ALICE);
    expect(task.tmEndpointAddress).toMatch(TM_APP_ADDRESS_PATTERN);
    expect(task.initiatorAgentId).toBe(ALICE);
    expect(task.status).toBe(TASK_STATUS_WAITING);
  });
}

function bindsDefaultGroupTmAddress() {
  return Effect.gen(function* () {
    const svc = makeService();
    const dmTask = yield* svc.createDefaultTaskForType("dm", ALICE);
    const groupTask = yield* svc.createDefaultTaskForType("group", ALICE);
    expect(groupTask.tmEndpointAddress).toMatch(TM_APP_ADDRESS_PATTERN);
    expect(groupTask.tmEndpointAddress).not.toBe(dmTask.tmEndpointAddress);
  });
}

function rejectsCloseFromNonTm() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, aliceAsTm());
    const exit = yield* Effect.exit(
      svc.close(task.id, BOB).pipe(withTmAuth(task.id, BOB, svc)),
    );
    expect(rpcFailureCode(exit)).toBe(ForbiddenError.code);
  });
}

function closesTaskFromRegisteredTm() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, aliceAsTm());
    const closed = yield* svc
      .close(task.id, ALICE)
      .pipe(withTmAuth(task.id, ALICE, svc));
    expect(closed.status).toBe(TASK_STATUS_CLOSED);
    expect(closed.endedAt).not.toBeNull();
  });
}

function restrictsAddParticipantToRegisteredTm() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, aliceAsTm());

    const denied = yield* Effect.exit(
      svc
        .addParticipant(task.id, BOB, CAROL)
        .pipe(withTmAuth(task.id, BOB, svc)),
    );
    expect(rpcFailureCode(denied)).toBe(ForbiddenError.code);

    const participant = yield* svc
      .addParticipant(task.id, ALICE, CAROL)
      .pipe(withTmAuth(task.id, ALICE, svc));
    expect(participant.agentId).toBe(CAROL);
    expect(participant.admittedAt).not.toBeNull();
  });
}

function restrictsRemoveParticipantToRegisteredTm() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, {
      ...aliceAsTm(),
      invitedAgentIds: [BOB],
    });

    const denied = yield* Effect.exit(
      svc
        .removeParticipant(task.id, CAROL, BOB)
        .pipe(withTmAuth(task.id, CAROL, svc)),
    );
    expect(rpcFailureCode(denied)).toBe(ForbiddenError.code);

    yield* svc
      .removeParticipant(task.id, ALICE, BOB)
      .pipe(withTmAuth(task.id, ALICE, svc));
    const view = yield* svc
      .get(task.id, ALICE)
      .pipe(withReadAccess(task.id, ALICE, svc));
    expect(view.participants.find((p) => p.agentId === BOB)).toBeUndefined();
  });
}

function rejectsMutationAfterClose() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, aliceAsTm());
    yield* svc.close(task.id, ALICE).pipe(withTmAuth(task.id, ALICE, svc));

    const addExit = yield* Effect.exit(
      svc
        .addParticipant(task.id, ALICE, BOB)
        .pipe(withTmAuth(task.id, ALICE, svc)),
    );
    expect(rpcFailureCode(addExit)).toBe(ForbiddenError.code);

    const closeExit = yield* Effect.exit(
      svc.close(task.id, ALICE).pipe(withTmAuth(task.id, ALICE, svc)),
    );
    expect(rpcFailureCode(closeExit)).toBe(ForbiddenError.code);
  });
}

function deniesReadAccessToPendingInvitee() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, {
      ...aliceAsTm(),
      invitedAgentIds: [BOB],
    });
    const exit = yield* Effect.exit(
      svc.get(task.id, BOB).pipe(withReadAccess(task.id, BOB, svc)),
    );
    expect(rpcFailureCode(exit)).toBe(ForbiddenError.code);
  });
}

function rejectsForeignFormattedPersistedAddress() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, aliceAsTm());
    yield* setPersistedTmEndpoint(task.id, FOREIGN_TM_ENDPOINT);
    const exit = yield* Effect.exit(svc.loadTaskAsTmAuthority(task.id, ALICE));
    expect(rpcFailureCode(exit)).toBe(ForbiddenError.code);
  });
}

function rejectsEmptyPersistedAddress() {
  return Effect.gen(function* () {
    const svc = makeService();
    const task = yield* svc.create(ALICE, aliceAsTm());
    yield* setPersistedTmEndpoint(task.id, EMPTY_TM_ENDPOINT);
    const exit = yield* Effect.exit(svc.loadTaskAsTmAuthority(task.id, ALICE));
    expect(rpcFailureCode(exit)).toBe(ForbiddenError.code);
  });
}

function registerCreateReadListTests() {
  describe("create + get + list", () => {
    it(
      "creates a waiting task with the initiator auto-admitted and the requested TM bound",
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
    it(
      "preserves the agent endpoint address contract",
      endpointAddressProperty,
    );
  });
}

function registerDefaultTmTests() {
  describe("createDefaultTaskForType", () => {
    it("DM type binds the default DM TM address", bindsDefaultDmTmAddress);
    it(
      "group type binds the default group TM address",
      bindsDefaultGroupTmAddress,
    );
  });
}

function registerTmAuthorityTests() {
  describe("loadTaskAsTmAuthority", () => {
    it(
      "close: rejects caller that isn't the registered TM",
      rejectsCloseFromNonTm,
    );
    it(
      "close: registered TM transitions task to closed",
      closesTaskFromRegisteredTm,
    );
    it(
      "addParticipant: only registered TM may add",
      restrictsAddParticipantToRegisteredTm,
    );
    it(
      "removeParticipant: only registered TM may remove",
      restrictsRemoveParticipantToRegisteredTm,
    );
    it("distinguishes non-TM agent endpoint addresses", nonTmEndpointProperty);
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

function registerBrandDecodedTmAuthorityTests() {
  describe("brand-decoded TM authority", () => {
    it(
      "rejects when persisted address is foreign-formatted",
      rejectsForeignFormattedPersistedAddress,
    );
    it("rejects when persisted address is empty", rejectsEmptyPersistedAddress);
  });
}

describe("TaskService", () => {
  beforeEach(() => Effect.runPromise(setupHarness()), PGLITE_HOOK_TIMEOUT_MS);
  afterEach(() => Effect.runPromise(harness.close), PGLITE_HOOK_TIMEOUT_MS);

  registerCreateReadListTests();
  registerDefaultTmTests();
  registerTmAuthorityTests();
  registerClosedTaskTests();
  registerPendingInviteeTests();
  registerBrandDecodedTmAuthorityTests();
});
