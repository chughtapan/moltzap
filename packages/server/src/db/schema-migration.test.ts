import { it as effectIt } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import {
  agentId,
  conversationId,
  taskId,
  userId,
} from "@moltzap/protocol/testing";
import {
  makePgliteHarness,
  PGLITE_HOOK_TIMEOUT_MS,
  type PgliteHarness,
} from "../test-utils/pglite-harness.js";
import { takeFirstOrFail } from "./effect-kysely-toolkit.js";

const it = effectIt.scoped;

const AGENT_ID = agentId("00000000-0000-4000-8000-0000000a9e47");
const OWNER_USER_ID = userId("00000000-0000-4000-8000-00000000a9e0");
const TASK_ID = taskId("00000000-0000-4000-8000-0000000fa5c0");
const CONV_ID = conversationId("00000000-0000-4000-8000-0000000c01f5");
const ORPHAN_TASK_ID = taskId("00000000-0000-4000-8000-0000000d3ad0");
const API_KEY_SECRET_HASH_LENGTH = 64;
const APP_KEY_ID = "fedcba9876543210";
const APP_MANIFEST_JSON = { name: "schema-fixture-app" };
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUS_WAITING = "waiting";
const WEREWOLF_APP_ID = "werewolf";
const DEFAULT_APP_ID = "default";
const MESSAGE_SEQ = "1";
const LEGACY_TABLES = [
  "app_sessions",
  "app_session_participants",
  "app_session_conversations",
  "message_delivery",
] as const;
const LEGACY_ENUMS = [
  "app_session_status",
  "app_participant_status",
  "delivery_status",
] as const;

describe("tasks schema task constraints", () => {
  it(
    "creates a task with default status",
    createsTaskWithDefaults,
    PGLITE_HOOK_TIMEOUT_MS,
  );

  it(
    "rejects a task insert that omits app_id",
    rejectsTaskWithoutAppId,
    PGLITE_HOOK_TIMEOUT_MS,
  );
});

describe("tasks schema conversation constraints", () => {
  it(
    "admits an agent into a task and links a conversation and message",
    linksConversationAndMessageToTask,
    PGLITE_HOOK_TIMEOUT_MS,
  );

  it(
    "rejects a conversation insert that omits task_id",
    rejectsConversationWithoutTask,
    PGLITE_HOOK_TIMEOUT_MS,
  );

  it(
    "rejects conversations.task_id that does not reference a real task",
    rejectsConversationWithOrphanTask,
    PGLITE_HOOK_TIMEOUT_MS,
  );
});

describe("apps schema constraints", () => {
  it(
    "inserts an app with server-issued app_id + id",
    insertsAppWithServerIssuedIds,
    PGLITE_HOOK_TIMEOUT_MS,
  );

  it(
    "rejects an app insert that omits manifest_json",
    rejectsAppWithoutManifest,
    PGLITE_HOOK_TIMEOUT_MS,
  );

  it(
    "rejects a duplicate api_key_id",
    rejectsDuplicateAppApiKeyId,
    PGLITE_HOOK_TIMEOUT_MS,
  );
});

describe("tasks schema destructive migration guard", () => {
  it("legacy tables are gone", legacyTablesAreGone, PGLITE_HOOK_TIMEOUT_MS);

  it("legacy enums are gone", legacyEnumsAreGone, PGLITE_HOOK_TIMEOUT_MS);

  it(
    "tasks and task_participants survive",
    survivingTablesRemain,
    PGLITE_HOOK_TIMEOUT_MS,
  );
});

function createsTaskWithDefaults() {
  return withTaskSchemaHarness((harness) =>
    Effect.gen(function* () {
      yield* insertTask(harness, WEREWOLF_APP_ID);

      const task = yield* takeFirstOrFail(
        harness.db
          .selectFrom("tasks")
          .select(["status", "app_id", "started_at", "ended_at"])
          .where("id", "=", TASK_ID),
      );
      expect(task.status).toBe(STATUS_WAITING);
      expect(task.app_id).toBe(WEREWOLF_APP_ID);
      expect(task.started_at).toBeNull();
      expect(task.ended_at).toBeNull();
    }),
  );
}

function rejectsTaskWithoutAppId() {
  return withTaskSchemaHarness((harness) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        harness.exec(
          `INSERT INTO tasks (initiator_agent_id) VALUES ('${AGENT_ID}')`,
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
}

function linksConversationAndMessageToTask() {
  return withTaskSchemaHarness((harness) =>
    Effect.gen(function* () {
      yield* insertTask(harness, DEFAULT_APP_ID);
      yield* admitAgentToTask(harness);
      yield* insertConversation(harness, TASK_ID);
      yield* insertMessage(harness);
      yield* expectTaskLinks(harness);
    }),
  );
}

function rejectsConversationWithoutTask() {
  return withTaskSchemaHarness((harness) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        harness.exec(
          `INSERT INTO conversations (id, created_by_id) VALUES ('${CONV_ID}', '${AGENT_ID}')`,
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
}

function rejectsConversationWithOrphanTask() {
  return withTaskSchemaHarness((harness) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        harness.db.insertInto("conversations").values({
          id: CONV_ID,
          created_by_id: AGENT_ID,
          task_id: ORPHAN_TASK_ID,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
}

function insertsAppWithServerIssuedIds() {
  return withTaskSchemaHarness((harness) =>
    Effect.gen(function* () {
      yield* harness.db.insertInto("apps").values({
        manifest_json: APP_MANIFEST_JSON,
        api_key_id: APP_KEY_ID,
        api_key_secret_hash: "y".repeat(API_KEY_SECRET_HASH_LENGTH),
      });

      const app = yield* takeFirstOrFail(
        harness.db
          .selectFrom("apps")
          .select(["app_id", "api_key_id", "manifest_json"])
          .where("api_key_id", "=", APP_KEY_ID),
      );
      expect(app.app_id).toMatch(UUID_RE);
      expect(app.api_key_id).toBe(APP_KEY_ID);
      expect(app.manifest_json).toEqual(APP_MANIFEST_JSON);
    }),
  );
}

function rejectsAppWithoutManifest() {
  return withTaskSchemaHarness((harness) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        harness.exec(
          `INSERT INTO apps (api_key_id, api_key_secret_hash)
           VALUES ('${APP_KEY_ID}', '${"y".repeat(API_KEY_SECRET_HASH_LENGTH)}')`,
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
}

function rejectsDuplicateAppApiKeyId() {
  return withTaskSchemaHarness((harness) =>
    Effect.gen(function* () {
      yield* harness.db.insertInto("apps").values({
        manifest_json: APP_MANIFEST_JSON,
        api_key_id: APP_KEY_ID,
        api_key_secret_hash: "y".repeat(API_KEY_SECRET_HASH_LENGTH),
      });

      const exit = yield* Effect.exit(
        harness.db.insertInto("apps").values({
          manifest_json: APP_MANIFEST_JSON,
          api_key_id: APP_KEY_ID,
          api_key_secret_hash: "z".repeat(API_KEY_SECRET_HASH_LENGTH),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
}

function legacyTablesAreGone() {
  return withTaskSchemaHarness((harness) =>
    Effect.gen(function* () {
      for (const tableName of LEGACY_TABLES) {
        const exit = yield* Effect.exit(
          harness.exec(`SELECT 1 FROM ${tableName} LIMIT 1`),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }
      expect(LEGACY_TABLES.length).toBeGreaterThan(0);
    }),
  );
}

function legacyEnumsAreGone() {
  return withTaskSchemaHarness((harness) =>
    Effect.gen(function* () {
      for (const typeName of LEGACY_ENUMS) {
        yield* harness.exec(`CREATE TYPE ${typeName} AS ENUM ('probe')`);
        yield* harness.exec(`DROP TYPE ${typeName}`);
      }
      expect(LEGACY_ENUMS.length).toBeGreaterThan(0);
    }),
  );
}

function survivingTablesRemain() {
  return withTaskSchemaHarness((harness) =>
    Effect.gen(function* () {
      const tasks = yield* harness.exec("SELECT 1 FROM tasks LIMIT 1");
      const participants = yield* harness.exec(
        "SELECT 1 FROM task_participants LIMIT 1",
      );
      expect(tasks).toBeDefined();
      expect(participants).toBeDefined();
    }),
  );
}

function withTaskSchemaHarness<A>(
  run: (harness: PgliteHarness) => Effect.Effect<A, unknown>,
): Effect.Effect<A, unknown> {
  return Effect.scoped(
    Effect.acquireRelease(makePgliteHarness(), closeHarness).pipe(
      Effect.flatMap((harness) => seedAndRunHarness(harness, run)),
    ),
  );
}

function closeHarness(harness: PgliteHarness): Effect.Effect<void> {
  return harness.close.pipe(Effect.orDie);
}

function seedAndRunHarness<A>(
  harness: PgliteHarness,
  run: (harness: PgliteHarness) => Effect.Effect<A, unknown>,
): Effect.Effect<A, unknown> {
  return seedTaskSchemaHarness(harness).pipe(
    Effect.flatMap(() => run(harness)),
  );
}

function seedTaskSchemaHarness(
  harness: PgliteHarness,
): Effect.Effect<unknown, unknown> {
  return harness.exec(`
    INSERT INTO encryption_keys (version, encrypted_key)
    VALUES (1, 'test-kek');

    INSERT INTO agents (
      id,
      owner_user_id,
      name,
      api_key_id,
      api_key_secret_hash,
      status
    )
    VALUES (
      '${AGENT_ID}',
      '${OWNER_USER_ID}',
      'task-fixture',
      '0123456789abcdef',
      '${"x".repeat(API_KEY_SECRET_HASH_LENGTH)}',
      'active'
    );
  `);
}

function insertTask(harness: PgliteHarness, appId: string) {
  return harness.db.insertInto("tasks").values({
    id: TASK_ID,
    app_id: appId,
    initiator_agent_id: AGENT_ID,
  });
}

function admitAgentToTask(harness: PgliteHarness) {
  return harness.db
    .insertInto("task_participants")
    .values({ task_id: TASK_ID, agent_id: AGENT_ID, admitted_at: new Date() });
}

function insertConversation(harness: PgliteHarness, task: typeof TASK_ID) {
  return harness.db.insertInto("conversations").values({
    id: CONV_ID,
    created_by_id: AGENT_ID,
    task_id: task,
  });
}

function insertMessage(harness: PgliteHarness) {
  return harness.db.insertInto("messages").values({
    conversation_id: CONV_ID,
    sender_id: AGENT_ID,
    seq: MESSAGE_SEQ,
    parts_encrypted: Buffer.from(""),
    parts_iv: Buffer.from(""),
    parts_tag: Buffer.from(""),
    kek_version: 1,
    task_id: TASK_ID,
  });
}

function expectTaskLinks(harness: PgliteHarness) {
  return Effect.gen(function* () {
    const conv = yield* takeFirstOrFail(
      harness.db
        .selectFrom("conversations")
        .select(["task_id"])
        .where("id", "=", CONV_ID),
    );
    expect(conv.task_id).toBe(TASK_ID);

    const message = yield* takeFirstOrFail(
      harness.db
        .selectFrom("messages")
        .select(["task_id"])
        .where("conversation_id", "=", CONV_ID),
    );
    expect(message.task_id).toBe(TASK_ID);

    const part = yield* takeFirstOrFail(
      harness.db
        .selectFrom("task_participants")
        .select(["agent_id", "admitted_at"])
        .where("task_id", "=", TASK_ID),
    );
    expect(part.agent_id).toBe(AGENT_ID);
    expect(part.admitted_at).not.toBeNull();
  });
}
