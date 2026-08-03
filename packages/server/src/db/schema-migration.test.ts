import { it as effectIt } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { describe, expect } from "vitest";
import {
  agentId,
  conversationId,
  messageId,
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
const CONV_ID = conversationId("00000000-0000-4000-8000-0000000c01f5");
const API_KEY_SECRET_HASH_LENGTH = 64;
const MESSAGE_ID = messageId("00000000-0000-4000-8000-0000000e5a91");
const MESSAGE_PARTS = [{ type: "text", text: "schema fixture" }];
const REMOVED_SCHEMA_TABLES = [
  "app_sessions",
  "app_session_participants",
  "app_session_conversations",
  "message_delivery",
  "tasks",
  "task_participants",
  "apps",
  "conversation_keys",
  "encryption_keys",
] as const;
const REMOVED_SCHEMA_ENUMS = [
  "app_session_status",
  "app_participant_status",
  "delivery_status",
  "task_status",
  "encryption_key_status",
] as const;
const REMOVED_CONVERSATION_COLUMNS = ["app_id"] as const;
const REMOVED_MESSAGE_COLUMNS = [
  "parts_encrypted",
  "parts_iv",
  "parts_tag",
  "dek_version",
  "kek_version",
  "dispatch_decision",
] as const;

describe("conversations schema constraints", () => {
  it(
    "stores a conversation keyed only by its creator",
    storesConversationWithoutAuthorityColumn,
    PGLITE_HOOK_TIMEOUT_MS,
  );

  it(
    "rejects a conversation insert that omits created_by_id",
    rejectsConversationWithoutCreator,
    PGLITE_HOOK_TIMEOUT_MS,
  );
});

describe("messages schema constraints", () => {
  it(
    "round-trips message parts through the plaintext jsonb column",
    roundTripsPlaintextParts,
    PGLITE_HOOK_TIMEOUT_MS,
  );

  it(
    "rejects a message insert that omits parts",
    rejectsMessageWithoutParts,
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
    "removed columns are absent",
    removedColumnsAreAbsent,
    PGLITE_HOOK_TIMEOUT_MS,
  );

  it(
    "removed enums are reusable",
    removedEnumsAreReusable,
    PGLITE_HOOK_TIMEOUT_MS,
  );
});

function storesConversationWithoutAuthorityColumn() {
  return withCoreSchemaHarness((harness) =>
    Effect.gen(function* () {
      yield* insertConversation(harness);

      const conv = yield* takeFirstOrFail(
        harness.db
          .selectFrom("conversations")
          .select(["id", "created_by_id"])
          .where("id", "=", CONV_ID),
      );
      expect(conv.id).toBe(CONV_ID);
      expect(conv.created_by_id).toBe(AGENT_ID);
    }),
  );
}

function rejectsConversationWithoutCreator() {
  return withCoreSchemaHarness((harness) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        harness.exec(`INSERT INTO conversations (id) VALUES ('${CONV_ID}')`),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );
}

function roundTripsPlaintextParts() {
  return withCoreSchemaHarness((harness) =>
    Effect.gen(function* () {
      yield* insertConversation(harness);
      yield* harness.db.insertInto("messages").values({
        id: MESSAGE_ID,
        conversation_id: CONV_ID,
        sender_id: AGENT_ID,
        seq: "1",
        parts: JSON.stringify(MESSAGE_PARTS),
      });

      const row = yield* takeFirstOrFail(
        harness.db
          .selectFrom("messages")
          .select(["parts", "is_deleted"])
          .where("id", "=", MESSAGE_ID),
      );
      expect(row.parts).toEqual(MESSAGE_PARTS);
      expect(row.is_deleted).toBe(false);
    }),
  );
}

function rejectsMessageWithoutParts() {
  return withCoreSchemaHarness((harness) =>
    Effect.gen(function* () {
      yield* insertConversation(harness);
      const exit = yield* Effect.exit(
        harness.exec(
          `INSERT INTO messages (id, conversation_id, sender_id, seq)
           VALUES ('${MESSAGE_ID}', '${CONV_ID}', '${AGENT_ID}', 1)`,
        ),
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

function removedColumnsAreAbsent() {
  return withCoreSchemaHarness((harness) =>
    Effect.gen(function* () {
      for (const column of REMOVED_CONVERSATION_COLUMNS) {
        const exit = yield* Effect.exit(
          harness.exec(`SELECT ${column} FROM conversations LIMIT 1`),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }
      for (const column of REMOVED_MESSAGE_COLUMNS) {
        const exit = yield* Effect.exit(
          harness.exec(`SELECT ${column} FROM messages LIMIT 1`),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }
      expect(REMOVED_MESSAGE_COLUMNS.length).toBeGreaterThan(0);
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

function insertConversation(harness: PgliteHarness) {
  return harness.db.insertInto("conversations").values({
    id: CONV_ID,
    created_by_id: AGENT_ID,
  });
}
