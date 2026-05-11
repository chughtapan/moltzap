import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cause, Effect, Exit } from "effect";
import { ForbiddenError, NotFoundError } from "@moltzap/protocol";
import {
  agentId,
  taskId as makeTaskId,
  wireErrorFromInstance,
} from "@moltzap/protocol/testing";
import type { Kysely } from "kysely";
import type { Database } from "../../db/database.js";
import { TaskService, endpointAddressForAgent } from "./task.service.js";
import type { ConversationService } from "./conversation.service.js";
import type { MessageService } from "./message.service.js";
import {
  makePgliteHarness,
  PGLITE_HOOK_TIMEOUT_MS,
  type PgliteHarness,
} from "../../test-utils/index.js";

// Lifecycle + authority methods never invoke these deps; the conversation
// + message paths are covered by `__tests__/integration/43-tasks.integration.test.ts`.
const STUB_CONV = {} as ConversationService;
const STUB_MSG = {} as MessageService;

const ALICE = agentId("00000000-0000-4000-8000-00000000a11c");
const BOB = agentId("00000000-0000-4000-8000-00000000b0b0");
const CAROL = agentId("00000000-0000-4000-8000-00000000ca20");

let harness: PgliteHarness;
let db: Kysely<Database>;

async function freshDb(): Promise<void> {
  harness = await makePgliteHarness();
  db = harness.db;
  // Seed agents — raw insert satisfies the FK without exercising the
  // full agents-service registration path.
  await db
    .insertInto("agents")
    .values([
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
    ])
    .execute();
}

function rpcFailureCode(exit: Exit.Exit<unknown, unknown>): number | null {
  if (Exit.isSuccess(exit)) return null;
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "None") return null;
  return wireErrorFromInstance(failure.value)?.code ?? null;
}

describe("TaskService", () => {
  beforeEach(async () => {
    await freshDb();
  }, PGLITE_HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await harness.close();
  }, PGLITE_HOOK_TIMEOUT_MS);

  // Phase 9b consumer-migration (sub-issue #460 round 3 R12+R13):
  // tasks.tm_endpoint_address is NOT NULL and tasks/create REQUIRES
  // tmEndpointAddress at insert. Tests that pre-R13 created a task and
  // then registerTm'd now pass `tmEndpointAddress: endpointAddressForAgent(<TM>)`
  // at create time. The pre-R13 `registerTm` / `unregisterTm` describe
  // block retired alongside the wire RPCs.
  const aliceAsTm = () => ({
    tmEndpointAddress: endpointAddressForAgent(ALICE),
  });

  describe("create + get + list", () => {
    it("creates a waiting task with the initiator auto-admitted and the requested TM bound", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(svc.create(ALICE, aliceAsTm()));
      expect(task.status).toBe("waiting");
      expect(task.initiatorAgentId).toBe(ALICE);
      expect(task.tmEndpointAddress).toBe(endpointAddressForAgent(ALICE));

      const view = await Effect.runPromise(svc.get(task.id, ALICE));
      expect(view.task.id).toBe(task.id);
      expect(view.participants).toHaveLength(1);
      expect(view.participants[0]!.agentId).toBe(ALICE);
      expect(view.participants[0]!.admittedAt).not.toBeNull();
    });

    it("admits initiator and pre-creates pending invited participants", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(
        svc.create(ALICE, { ...aliceAsTm(), invitedAgentIds: [BOB] }),
      );
      const view = await Effect.runPromise(svc.get(task.id, ALICE));
      const bobRow = view.participants.find((p) => p.agentId === BOB);
      expect(bobRow).toBeDefined();
      expect(bobRow!.admittedAt).toBeNull();
    });

    it("scopes list to caller's tasks (initiator OR participant)", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const aliceTask = await Effect.runPromise(svc.create(ALICE, aliceAsTm()));
      // Bob's separate task — Bob is the registered TM for his own task.
      await Effect.runPromise(
        svc.create(BOB, { tmEndpointAddress: endpointAddressForAgent(BOB) }),
      );

      const aliceList = await Effect.runPromise(svc.list(ALICE, {}));
      expect(aliceList.map((t) => t.id)).toContain(aliceTask.id);
      expect(aliceList).toHaveLength(1);

      const carolList = await Effect.runPromise(svc.list(CAROL, {}));
      expect(carolList).toHaveLength(0);
    });

    it("rejects get when caller is neither initiator nor participant", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(svc.create(ALICE, aliceAsTm()));
      const exit = await Effect.runPromise(Effect.exit(svc.get(task.id, BOB)));
      expect(rpcFailureCode(exit)).toBe(ForbiddenError.code);
    });

    it("404s on get of unknown taskId", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const exit = await Effect.runPromise(
        Effect.exit(
          svc.get(makeTaskId("00000000-0000-4000-8000-deadbeefcafe"), ALICE),
        ),
      );
      expect(rpcFailureCode(exit)).toBe(NotFoundError.code);
    });
  });

  describe("createDefaultTaskForType — server-internal default-TM helper", () => {
    it("DM type binds the default DM TM address", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(
        svc.createDefaultTaskForType("dm", ALICE),
      );
      expect(task.tmEndpointAddress).toMatch(/^tm:app:/);
      expect(task.initiatorAgentId).toBe(ALICE);
      expect(task.status).toBe("waiting");
    });

    it("group type binds the default group TM address (distinct from DM)", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const dmTask = await Effect.runPromise(
        svc.createDefaultTaskForType("dm", ALICE),
      );
      const groupTask = await Effect.runPromise(
        svc.createDefaultTaskForType("group", ALICE),
      );
      expect(groupTask.tmEndpointAddress).toMatch(/^tm:app:/);
      expect(groupTask.tmEndpointAddress).not.toBe(dmTask.tmEndpointAddress);
    });
  });

  describe("requireTmAuthority — every mutation routes through it", () => {
    it("close: rejects caller that isn't the registered TM", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(svc.create(ALICE, aliceAsTm()));

      const exit = await Effect.runPromise(
        Effect.exit(svc.close(task.id, BOB)),
      );
      expect(rpcFailureCode(exit)).toBe(ForbiddenError.code);
    });

    it("close: registered TM transitions task to closed", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(svc.create(ALICE, aliceAsTm()));

      const closed = await Effect.runPromise(svc.close(task.id, ALICE));
      expect(closed.status).toBe("closed");
      expect(closed.endedAt).not.toBeNull();
    });

    it("addParticipant: only registered TM may add", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(svc.create(ALICE, aliceAsTm()));

      const denied = await Effect.runPromise(
        Effect.exit(svc.addParticipant(task.id, BOB, CAROL)),
      );
      expect(rpcFailureCode(denied)).toBe(ForbiddenError.code);

      const participant = await Effect.runPromise(
        svc.addParticipant(task.id, ALICE, CAROL),
      );
      expect(participant.agentId).toBe(CAROL);
      expect(participant.admittedAt).not.toBeNull();
    });

    it("removeParticipant: only registered TM may remove", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(
        svc.create(ALICE, { ...aliceAsTm(), invitedAgentIds: [BOB] }),
      );

      const denied = await Effect.runPromise(
        Effect.exit(svc.removeParticipant(task.id, CAROL, BOB)),
      );
      expect(rpcFailureCode(denied)).toBe(ForbiddenError.code);

      await Effect.runPromise(svc.removeParticipant(task.id, ALICE, BOB));
      const view = await Effect.runPromise(svc.get(task.id, ALICE));
      expect(view.participants.find((p) => p.agentId === BOB)).toBeUndefined();
    });
  });

  describe("closed-task immutability", () => {
    it("rejects mutations after close even by the registered TM", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(svc.create(ALICE, aliceAsTm()));
      await Effect.runPromise(svc.close(task.id, ALICE));

      const addExit = await Effect.runPromise(
        Effect.exit(svc.addParticipant(task.id, ALICE, BOB)),
      );
      expect(rpcFailureCode(addExit)).toBe(ForbiddenError.code);

      const closeExit = await Effect.runPromise(
        Effect.exit(svc.close(task.id, ALICE)),
      );
      expect(rpcFailureCode(closeExit)).toBe(ForbiddenError.code);
    });
  });

  describe("read access denies pending invitees", () => {
    it("admitted_at IS NULL means no read access", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(
        svc.create(ALICE, { ...aliceAsTm(), invitedAgentIds: [BOB] }),
      );
      const exit = await Effect.runPromise(Effect.exit(svc.get(task.id, BOB)));
      expect(rpcFailureCode(exit)).toBe(ForbiddenError.code);
    });
  });

  describe("brand-decoded TM authority", () => {
    // The brand factory rejects malformed addresses at construction
    // (Brand.refined predicate). The service maps the throw to a
    // typed RpcFailure so a corrupt persisted column never silently
    // compares as a non-match. Phase 9b consumer-migration (sub-issue
    // #460 round 3 R12): the schema-level NOT NULL forbids the null
    // case at insert time; only foreign-formatted persisted strings
    // (DB tampering) can still flow through this branch.
    it("rejects when persisted address is foreign-formatted", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(svc.create(ALICE, aliceAsTm()));
      await db
        .updateTable("tasks")
        .set({ tm_endpoint_address: "tm://foreign/addr-1" })
        .where("id", "=", task.id)
        .execute();
      const exit = await Effect.runPromise(
        Effect.exit(svc.requireTmAuthority(task.id, ALICE)),
      );
      expect(rpcFailureCode(exit)).toBe(ForbiddenError.code);
    });

    it("rejects when persisted address is empty", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(svc.create(ALICE, aliceAsTm()));
      await db
        .updateTable("tasks")
        .set({ tm_endpoint_address: "" })
        .where("id", "=", task.id)
        .execute();
      const exit = await Effect.runPromise(
        Effect.exit(svc.requireTmAuthority(task.id, ALICE)),
      );
      expect(rpcFailureCode(exit)).toBe(ForbiddenError.code);
    });
  });
});
