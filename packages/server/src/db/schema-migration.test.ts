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
const APP_SESSION_ID = "00000000-0000-4000-8000-0000000a99e5";
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

describe("core-schema.sql Phase 5 B1 additive migration", () => {
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

  it("leaves app_sessions and unlinked conversations untouched (additive coexistence)", async () => {
    await db
      .insertInto("app_sessions")
      .values({
        id: APP_SESSION_ID,
        app_id: "legacy-app",
        initiator_agent_id: AGENT_ID,
      })
      .execute();
    await db
      .insertInto("conversations")
      .values({ id: CONV_ID, type: "dm", created_by_id: AGENT_ID })
      .execute();

    const session = await db
      .selectFrom("app_sessions")
      .select(["app_id", "status"])
      .where("id", "=", APP_SESSION_ID)
      .executeTakeFirstOrThrow();
    expect(session.app_id).toBe("legacy-app");
    expect(session.status).toBe("waiting");

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
});
