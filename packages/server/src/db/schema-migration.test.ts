import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentId, conversationId, taskId } from "@moltzap/protocol/testing";
import { makeEffectKysely } from "./effect-kysely-toolkit.js";
import type { Database } from "./database.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(
  join(__dirname, "..", "app", "core-schema.sql"),
  "utf-8",
);
const DB_HOOK_TIMEOUT_MS = 30_000;

const AGENT_ID = agentId("00000000-0000-4000-8000-0000000a9e47");
const TASK_ID = taskId("00000000-0000-4000-8000-0000000fa5c0");
const CONV_ID = conversationId("00000000-0000-4000-8000-0000000c01f5");
const ORPHAN_TASK_ID = taskId("00000000-0000-4000-8000-0000000d3ad0");
const API_KEY_SECRET_HASH_LENGTH = 64;

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
  await db
    .insertInto("encryption_keys")
    .values({ version: 1, encrypted_key: "test-kek" })
    .execute();
  await db
    .insertInto("agents")
    .values({
      id: AGENT_ID,
      name: "task-fixture",
      api_key_id: "0123456789abcdef",
      api_key_secret_hash: "x".repeat(API_KEY_SECRET_HASH_LENGTH),
      claim_token: "claim-task-fixture",
      status: "active",
    })
    .execute();
}

describe("tasks schema (core-schema.sql)", () => {
  beforeEach(async () => {
    await freshDb();
  }, DB_HOOK_TIMEOUT_MS);

  afterEach(async () => {
    await pglite.close();
  }, DB_HOOK_TIMEOUT_MS);

  it("creates a task with default status='waiting' and a NOT NULL tm_endpoint_address", async () => {
    // Phase 9b consumer-migration (sub-issue #460 round 3 R12):
    // `tasks.tm_endpoint_address` flipped to NOT NULL alongside the
    // atomic `tasks/create` (R13) — the schema-level constraint is what
    // forbids the intermediate "task without TM" state, replacing the
    // pre-R12 service-level vacuous fail-closed branch.
    await db
      .insertInto("tasks")
      .values({
        id: TASK_ID,
        app_id: "werewolf",
        initiator_agent_id: AGENT_ID,
        tm_endpoint_address: "tm://werewolf/host-1",
      })
      .execute();

    const task = await db
      .selectFrom("tasks")
      .select(["status", "tm_endpoint_address", "started_at", "ended_at"])
      .where("id", "=", TASK_ID)
      .executeTakeFirstOrThrow();
    expect(task.status).toBe("waiting");
    expect(task.tm_endpoint_address).toBe("tm://werewolf/host-1");
    expect(task.started_at).toBeNull();
    expect(task.ended_at).toBeNull();
  });

  it("rejects a task insert that omits tm_endpoint_address", async () => {
    // Phase 9b consumer-migration (sub-issue #460 round 3 R12):
    // pre-R12 this was a legal "register-the-TM-later" insert. Now the
    // NOT NULL constraint rejects it at the SQL boundary, so no caller
    // can sneak past the atomic `tasks/create` requirement.
    await expect(
      pglite.exec(
        `INSERT INTO tasks (initiator_agent_id) VALUES ('${AGENT_ID}')`,
      ),
    ).rejects.toThrow(/null|violates|tm_endpoint_address/i);
  });

  it("admits an agent into a task and links a conversation + message to it", async () => {
    await db
      .insertInto("tasks")
      .values({
        id: TASK_ID,
        initiator_agent_id: AGENT_ID,
        tm_endpoint_address: "tm:agent:00000000-0000-4000-8000-0000000a9e47",
      })
      .execute();
    await db
      .insertInto("task_participants")
      .values({ task_id: TASK_ID, agent_id: AGENT_ID, admitted_at: new Date() })
      .execute();
    await db
      .insertInto("conversations")
      .values({
        id: CONV_ID,
        type: "group",
        created_by_id: AGENT_ID,
        task_id: TASK_ID,
      })
      .execute();
    await db
      .insertInto("messages")
      .values({
        conversation_id: CONV_ID,
        sender_id: AGENT_ID,
        seq: "1",
        parts_encrypted: Buffer.from(""),
        parts_iv: Buffer.from(""),
        parts_tag: Buffer.from(""),
        kek_version: 1,
        task_id: TASK_ID,
      })
      .execute();

    const conv = await db
      .selectFrom("conversations")
      .select(["task_id"])
      .where("id", "=", CONV_ID)
      .executeTakeFirstOrThrow();
    expect(conv.task_id).toBe(TASK_ID);

    const message = await db
      .selectFrom("messages")
      .select(["task_id"])
      .where("conversation_id", "=", CONV_ID)
      .executeTakeFirstOrThrow();
    expect(message.task_id).toBe(TASK_ID);

    const part = await db
      .selectFrom("task_participants")
      .select(["agent_id", "admitted_at"])
      .where("task_id", "=", TASK_ID)
      .executeTakeFirstOrThrow();
    expect(part.agent_id).toBe(AGENT_ID);
    expect(part.admitted_at).not.toBeNull();
  });

  it("rejects a conversation insert that omits task_id", async () => {
    // Phase 9b consumer-migration (sub-issue #460 round 3 R12):
    // `conversations.task_id` is NOT NULL by schema. Pre-R12 the
    // `tasks/createConversation` flow tolerated unlinked conversations
    // and post-bound them via UPDATE; the atomic `tasks/create` (R13)
    // makes that two-step unnecessary, and the schema constraint
    // forbids any caller from minting a task-less conversation.
    await expect(
      pglite.exec(
        `INSERT INTO conversations (id, type, created_by_id) VALUES ('${CONV_ID}', 'dm', '${AGENT_ID}')`,
      ),
    ).rejects.toThrow(/null|violates|task_id/i);
  });

  it("rejects conversations.task_id that does not reference a real task", async () => {
    await expect(
      db
        .insertInto("conversations")
        .values({
          id: CONV_ID,
          type: "group",
          created_by_id: AGENT_ID,
          task_id: ORPHAN_TASK_ID,
        })
        .execute(),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  // Destructive-migration guard: every dropped relation must reject
  // re-use. SELECTing a legacy table errors with `relation … does not
  // exist`; the surviving `tasks` table SELECTs an empty row set.
  // Future drift (re-introducing tables OR leaving enum types behind)
  // trips the assertions below instead of silently reintroducing the
  // schema. `app_sessions*` rows are Phase 7 (sub-issue #425);
  // `message_delivery` is Phase 7.5 (sub-issue #450).
  it.each([
    "app_sessions",
    "app_session_participants",
    "app_session_conversations",
    "message_delivery",
  ])("table %s is gone", async (tableName) => {
    await expect(
      pglite.exec(`SELECT 1 FROM ${tableName} LIMIT 1`),
    ).rejects.toThrow(/does not exist/i);
  });

  it.each(["app_session_status", "app_participant_status", "delivery_status"])(
    "enum %s is gone",
    async (typeName) => {
      // Recreating the enum succeeds iff the prior cutover dropped it.
      // CREATE TYPE on an existing name errors "already exists";
      // the assertion proves the type is absent from the freshly-applied
      // schema.
      await pglite.exec(`CREATE TYPE ${typeName} AS ENUM ('probe')`);
      await pglite.exec(`DROP TYPE ${typeName}`);
    },
  );

  it("tasks + task_participants survive (positive control)", async () => {
    // SELECT against the surviving tables succeeds — proves the cutover
    // didn't accidentally drop too much.
    await pglite.exec("SELECT 1 FROM tasks LIMIT 1");
    await pglite.exec("SELECT 1 FROM task_participants LIMIT 1");
  });
});
