import { it as effectIt } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import { agentId, conversationId, userId } from "@moltzap/protocol/testing";
import {
  makePgliteHarness,
  PGLITE_HOOK_TIMEOUT_MS,
  type PgliteHarness,
} from "../test-utils/pglite-harness.js";
import { takeFirstOrFail } from "./effect-kysely-toolkit.js";

const it = effectIt.scoped;

const AGENT_ID = agentId("00000000-0000-4000-8000-0000000a9e47");
const OWNER_USER_ID = userId("00000000-0000-4000-8000-00000000a9e0");
const CONV_ID = conversationId("00000000-0000-4000-8000-0000000c01f5");
const API_KEY_SECRET_HASH_LENGTH = 64;
const APP_KEY_ID = "fedcba9876543210";
const APP_MANIFEST_JSON = { name: "schema-fixture-app" };
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEREWOLF_APP_ID = "werewolf";
const REMOVED_SCHEMA_TABLES = [
  "app_sessions",
  "app_session_participants",
  "app_session_conversations",
  "message_delivery",
  "tasks",
  "task_participants",
] as const;
const REMOVED_SCHEMA_ENUMS = [
  "app_session_status",
  "app_participant_status",
  "delivery_status",
  "task_status",
] as const;

describe("conversations schema constraints", () => {
  it(
    "routes a conversation to its authorizing app",
    routesConversationToApp,
    PGLITE_HOOK_TIMEOUT_MS,
  );

  it(
    "rejects a conversation insert that omits app_id",
    rejectsConversationWithoutApp,
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

describe("destructive migration guard", () => {
  it(
    "removed tables are absent",
    removedTablesAreAbsent,
    PGLITE_HOOK_TIMEOUT_MS,
  );

  it(
    "removed enums are reusable",
    removedEnumsAreReusable,
    PGLITE_HOOK_TIMEOUT_MS,
  );
});

function routesConversationToApp() {
  return withCoreSchemaHarness((harness) =>
    Effect.gen(function* () {
      yield* insertConversation(harness, WEREWOLF_APP_ID);

      const conv = yield* takeFirstOrFail(
        harness.db
          .selectFrom("conversations")
          .select(["app_id", "created_by_id"])
          .where("id", "=", CONV_ID),
      );
      expect(conv.app_id).toBe(WEREWOLF_APP_ID);
      expect(conv.created_by_id).toBe(AGENT_ID);
    }),
  );
}

function rejectsConversationWithoutApp() {
  return withCoreSchemaHarness((harness) =>
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

function insertsAppWithServerIssuedIds() {
  return withCoreSchemaHarness((harness) =>
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
  return withCoreSchemaHarness((harness) =>
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
  return withCoreSchemaHarness((harness) =>
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

function removedTablesAreAbsent() {
  return withCoreSchemaHarness((harness) =>
    Effect.gen(function* () {
      for (const tableName of REMOVED_SCHEMA_TABLES) {
        const exit = yield* Effect.exit(
          harness.exec(`SELECT 1 FROM ${tableName} LIMIT 1`),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }
      expect(REMOVED_SCHEMA_TABLES.length).toBeGreaterThan(0);
    }),
  );
}

function removedEnumsAreReusable() {
  return withCoreSchemaHarness((harness) =>
    Effect.gen(function* () {
      for (const typeName of REMOVED_SCHEMA_ENUMS) {
        yield* harness.exec(`CREATE TYPE ${typeName} AS ENUM ('probe')`);
        yield* harness.exec(`DROP TYPE ${typeName}`);
      }
      expect(REMOVED_SCHEMA_ENUMS.length).toBeGreaterThan(0);
    }),
  );
}

function withCoreSchemaHarness<A>(
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
  return seedCoreSchemaHarness(harness).pipe(
    Effect.flatMap(() => run(harness)),
  );
}

function seedCoreSchemaHarness(
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
      'schema-fixture',
      '0123456789abcdef',
      '${"x".repeat(API_KEY_SECRET_HASH_LENGTH)}',
      'active'
    );
  `);
}

function insertConversation(harness: PgliteHarness, appId: string) {
  return harness.db.insertInto("conversations").values({
    id: CONV_ID,
    created_by_id: AGENT_ID,
    app_id: appId,
  });
}
