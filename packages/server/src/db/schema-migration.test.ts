import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeEffectKysely } from "./effect-kysely-toolkit.js";
import type { Database } from "./database.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schema = readFileSync(
  join(__dirname, "..", "app", "core-schema.sql"),
  "utf-8",
);
const DB_HOOK_TIMEOUT_MS = 30_000;

const AGENT_ID = "00000000-0000-4000-8000-0000000a9e47";
const TASK_ID = "00000000-0000-4000-8000-0000000fa5c0";
const CONV_ID = "00000000-0000-4000-8000-0000000c01f5";
const ORPHAN_TASK_ID = "00000000-0000-4000-8000-0000000d3ad0";

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
      api_key_secret_hash: "x".repeat(64),
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

  it("creates a task with default status='waiting' and a nullable tm_endpoint_address", async () => {
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

    const unowned = await db
      .insertInto("tasks")
      .values({ initiator_agent_id: AGENT_ID })
      .returning(["app_id", "tm_endpoint_address"])
      .executeTakeFirstOrThrow();
    expect(unowned.app_id).toBeNull();
    expect(unowned.tm_endpoint_address).toBeNull();
  });

  it("admits an agent into a task and links a conversation + message to it", async () => {
    await db
      .insertInto("tasks")
      .values({ id: TASK_ID, initiator_agent_id: AGENT_ID })
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

  it("leaves unlinked conversations untouched (conversations.task_id stays nullable)", async () => {
    // Phase 7 cutover dropped the `app_sessions/app_session_*` tables.
    // The Phase 5 coexistence test that asserted `app_sessions` survived
    // alongside the additive `tasks` schema is no longer applicable; the
    // surviving invariant is "conversations created without a task stay
    // task-less," which the `tasks/createConversation` flow relies on.
    await db
      .insertInto("conversations")
      .values({ id: CONV_ID, type: "dm", created_by_id: AGENT_ID })
      .execute();

    const conv = await db
      .selectFrom("conversations")
      .select(["task_id"])
      .where("id", "=", CONV_ID)
      .executeTakeFirstOrThrow();
    expect(conv.task_id).toBeNull();
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

  // Phase 7 destructive-migration guard: every dropped relation must
  // reject re-use. SELECTing the legacy table errors with
  // `relation … does not exist`; the surviving `tasks` table SELECTs
  // an empty row set. Future drift (re-introducing the tables OR
  // leaving the enum types behind) trips the assertions below
  // instead of silently reintroducing the schema.
  it.each([
    "app_sessions",
    "app_session_participants",
    "app_session_conversations",
  ])("table %s is gone (Phase 7 cutover)", async (tableName) => {
    await expect(
      pglite.exec(`SELECT 1 FROM ${tableName} LIMIT 1`),
    ).rejects.toThrow(/does not exist/i);
  });

  it.each(["app_session_status", "app_participant_status"])(
    "enum %s is gone (Phase 7 cutover)",
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
