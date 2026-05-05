import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Cause, Effect, Exit } from "effect";
import { ErrorCodes, agentId, taskId as makeTaskId } from "@moltzap/protocol";
import type { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEffectKysely } from "../db/effect-kysely-toolkit.js";
import type { Database } from "../db/database.js";
import { RpcFailure } from "../runtime/index.js";
import { TaskService, endpointAddressForAgent } from "./task.service.js";
import type { ConversationService } from "./conversation.service.js";
import type { MessageService } from "./message.service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(
  join(__dirname, "..", "app", "core-schema.sql"),
  "utf-8",
);
const DB_HOOK_TIMEOUT_MS = 30_000;

// Lifecycle + authority methods never invoke these deps; the conversation
// + message paths are covered by `__tests__/integration/43-tasks.integration.test.ts`.
const STUB_CONV = {} as ConversationService;
const STUB_MSG = {} as MessageService;

const ALICE = agentId("00000000-0000-4000-8000-00000000a11c");
const BOB = agentId("00000000-0000-4000-8000-00000000b0b0");
const CAROL = agentId("00000000-0000-4000-8000-00000000ca20");

let db: Kysely<Database>;
let pglite: {
  exec: (sql: string) => Promise<unknown>;
  close: () => Promise<void>;
};

async function freshDb(): Promise<void> {
  const kpg = await KyselyPGlite.create();
  pglite = {
    exec: (sql) => kpg.client.exec(sql),
    close: () => kpg.client.close(),
  };
  db = makeEffectKysely<Database>({ dialect: kpg.dialect });
  await pglite.exec(schema);
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

function rpcFailureCode(exit: Exit.Exit<unknown, RpcFailure>): number | null {
  if (Exit.isSuccess(exit)) return null;
  const failure = Cause.failureOption(exit.cause);
  if (failure._tag === "None") return null;
  return failure.value.code;
}

describe("TaskService", () => {
  beforeEach(async () => {
    await freshDb();
  }, DB_HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await pglite.close();
  }, DB_HOOK_TIMEOUT_MS);

  describe("create + get + list", () => {
    it("creates a waiting task with the initiator auto-admitted", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(svc.create(ALICE, {}));
      expect(task.status).toBe("waiting");
      expect(task.initiatorAgentId).toBe(ALICE);
      expect(task.tmEndpointAddress).toBeNull();

      const view = await Effect.runPromise(svc.get(task.id, ALICE));
      expect(view.task.id).toBe(task.id);
      expect(view.participants).toHaveLength(1);
      expect(view.participants[0]!.agentId).toBe(ALICE);
      expect(view.participants[0]!.admittedAt).not.toBeNull();
    });

    it("admits initiator and pre-creates pending invited participants", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(
        svc.create(ALICE, { invitedAgentIds: [BOB] }),
      );
      const view = await Effect.runPromise(svc.get(task.id, ALICE));
      const bobRow = view.participants.find((p) => p.agentId === BOB);
      expect(bobRow).toBeDefined();
      expect(bobRow!.admittedAt).toBeNull();
    });

    it("scopes list to caller's tasks (initiator OR participant)", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const aliceTask = await Effect.runPromise(svc.create(ALICE, {}));
      // Bob's separate task
      await Effect.runPromise(svc.create(BOB, {}));

      const aliceList = await Effect.runPromise(svc.list(ALICE, {}));
      expect(aliceList.map((t) => t.id)).toContain(aliceTask.id);
      expect(aliceList).toHaveLength(1);

      const carolList = await Effect.runPromise(svc.list(CAROL, {}));
      expect(carolList).toHaveLength(0);
    });

    it("rejects get when caller is neither initiator nor participant", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(svc.create(ALICE, {}));
      const exit = await Effect.runPromise(Effect.exit(svc.get(task.id, BOB)));
      expect(rpcFailureCode(exit)).toBe(ErrorCodes.Forbidden);
    });

    it("404s on get of unknown taskId", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const exit = await Effect.runPromise(
        Effect.exit(
          svc.get(makeTaskId("00000000-0000-4000-8000-deadbeefcafe"), ALICE),
        ),
      );
      expect(rpcFailureCode(exit)).toBe(ErrorCodes.NotFound);
    });
  });

  describe("registerTm + unregisterTm", () => {
    it("first registration sets tm_endpoint_address to the caller-derived address", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(svc.create(ALICE, {}));
      const result = await Effect.runPromise(svc.registerTm(task.id, ALICE));
      expect(result.taskId).toBe(task.id);
      expect(result.tmEndpointAddress).toBe(endpointAddressForAgent(ALICE));

      const view = await Effect.runPromise(svc.get(task.id, ALICE));
      expect(view.task.tmEndpointAddress).toBe(endpointAddressForAgent(ALICE));
    });

    it("re-registration by the same caller is idempotent", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(svc.create(ALICE, {}));
      await Effect.runPromise(svc.registerTm(task.id, ALICE));
      const second = await Effect.runPromise(svc.registerTm(task.id, ALICE));
      expect(second.tmEndpointAddress).toBe(endpointAddressForAgent(ALICE));
    });

    it("rejects registration by a non-initiator", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(svc.create(ALICE, {}));
      const exit = await Effect.runPromise(
        Effect.exit(svc.registerTm(task.id, BOB)),
      );
      expect(rpcFailureCode(exit)).toBe(ErrorCodes.Forbidden);
    });

    it("rejects registration when a different TM is already registered", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(svc.create(ALICE, {}));
      await db
        .updateTable("tasks")
        .set({ tm_endpoint_address: endpointAddressForAgent(BOB) })
        .where("id", "=", task.id)
        .execute();
      const exit = await Effect.runPromise(
        Effect.exit(svc.registerTm(task.id, ALICE)),
      );
      expect(rpcFailureCode(exit)).toBe(ErrorCodes.Forbidden);
    });

    it("unregister clears tm_endpoint_address; only the registered TM may unregister", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(svc.create(ALICE, {}));
      await Effect.runPromise(svc.registerTm(task.id, ALICE));

      const denied = await Effect.runPromise(
        Effect.exit(svc.unregisterTm(task.id, BOB)),
      );
      expect(rpcFailureCode(denied)).toBe(ErrorCodes.Forbidden);

      await Effect.runPromise(svc.unregisterTm(task.id, ALICE));
      const view = await Effect.runPromise(svc.get(task.id, ALICE));
      expect(view.task.tmEndpointAddress).toBeNull();
    });
  });

  describe("requireTmAuthority — every mutation routes through it", () => {
    it("close: rejects caller that isn't the registered TM", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(svc.create(ALICE, {}));
      await Effect.runPromise(svc.registerTm(task.id, ALICE));

      const exit = await Effect.runPromise(
        Effect.exit(svc.close(task.id, BOB)),
      );
      expect(rpcFailureCode(exit)).toBe(ErrorCodes.Forbidden);
    });

    it("close: registered TM transitions task to closed", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(svc.create(ALICE, {}));
      await Effect.runPromise(svc.registerTm(task.id, ALICE));

      const closed = await Effect.runPromise(svc.close(task.id, ALICE));
      expect(closed.status).toBe("closed");
      expect(closed.endedAt).not.toBeNull();
    });

    it("close: rejects when no TM is registered (no-TM = no-authority)", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(svc.create(ALICE, {}));
      const exit = await Effect.runPromise(
        Effect.exit(svc.close(task.id, ALICE)),
      );
      expect(rpcFailureCode(exit)).toBe(ErrorCodes.Forbidden);
    });

    it("addParticipant: only registered TM may add", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(svc.create(ALICE, {}));
      await Effect.runPromise(svc.registerTm(task.id, ALICE));

      const denied = await Effect.runPromise(
        Effect.exit(svc.addParticipant(task.id, BOB, CAROL)),
      );
      expect(rpcFailureCode(denied)).toBe(ErrorCodes.Forbidden);

      const participant = await Effect.runPromise(
        svc.addParticipant(task.id, ALICE, CAROL),
      );
      expect(participant.agentId).toBe(CAROL);
      expect(participant.admittedAt).not.toBeNull();
    });

    it("removeParticipant: only registered TM may remove", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(
        svc.create(ALICE, { invitedAgentIds: [BOB] }),
      );
      await Effect.runPromise(svc.registerTm(task.id, ALICE));

      const denied = await Effect.runPromise(
        Effect.exit(svc.removeParticipant(task.id, CAROL, BOB)),
      );
      expect(rpcFailureCode(denied)).toBe(ErrorCodes.Forbidden);

      await Effect.runPromise(svc.removeParticipant(task.id, ALICE, BOB));
      const view = await Effect.runPromise(svc.get(task.id, ALICE));
      expect(view.participants.find((p) => p.agentId === BOB)).toBeUndefined();
    });
  });

  describe("closed-task immutability", () => {
    it("rejects mutations after close even by the registered TM", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(svc.create(ALICE, {}));
      await Effect.runPromise(svc.registerTm(task.id, ALICE));
      await Effect.runPromise(svc.close(task.id, ALICE));

      const addExit = await Effect.runPromise(
        Effect.exit(svc.addParticipant(task.id, ALICE, BOB)),
      );
      expect(rpcFailureCode(addExit)).toBe(ErrorCodes.Forbidden);

      const closeExit = await Effect.runPromise(
        Effect.exit(svc.close(task.id, ALICE)),
      );
      expect(rpcFailureCode(closeExit)).toBe(ErrorCodes.Forbidden);
    });
  });

  describe("read access denies pending invitees", () => {
    it("admitted_at IS NULL means no read access", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(
        svc.create(ALICE, { invitedAgentIds: [BOB] }),
      );
      const exit = await Effect.runPromise(Effect.exit(svc.get(task.id, BOB)));
      expect(rpcFailureCode(exit)).toBe(ErrorCodes.Forbidden);
    });
  });

  describe("brand-decoded TM authority", () => {
    // The brand factory rejects malformed addresses at construction
    // (Brand.refined predicate). The service maps the throw to a
    // typed RpcFailure so a corrupt persisted column never silently
    // compares as a non-match.
    it("rejects when persisted address is foreign-formatted", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(svc.create(ALICE, {}));
      await db
        .updateTable("tasks")
        .set({ tm_endpoint_address: "tm://foreign/addr-1" })
        .where("id", "=", task.id)
        .execute();
      const exit = await Effect.runPromise(
        Effect.exit(svc.requireTmAuthority(task.id, ALICE)),
      );
      expect(rpcFailureCode(exit)).toBe(ErrorCodes.Forbidden);
    });

    it("rejects when persisted address is empty", async () => {
      const svc = new TaskService(db, STUB_CONV, STUB_MSG);
      const task = await Effect.runPromise(svc.create(ALICE, {}));
      await db
        .updateTable("tasks")
        .set({ tm_endpoint_address: "" })
        .where("id", "=", task.id)
        .execute();
      const exit = await Effect.runPromise(
        Effect.exit(svc.requireTmAuthority(task.id, ALICE)),
      );
      expect(rpcFailureCode(exit)).toBe(ErrorCodes.Forbidden);
    });
  });
});
