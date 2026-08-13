/**
 * @file Pins the message store reader to the committed-message projection:
 * identity, plaintext body, and commit time. The fixture intentionally has no
 * deletion, reply, encryption, or dispatch columns.
 */
/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type, agent-code-guard/no-raw-sql, sonarjs/assertions-in-tests, max-nested-callbacks -- PGlite exposes a promise-native fixture API; fixture SQL and Effect-wrapped assertions are local to this projection regression. */
// @agent-code-guard/regression-only: the minimal table shape is the invariant under test
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import { PGlite } from "@electric-sql/pglite";
import { ConversationId } from "@moltzap/client";
import { agentId, messageId } from "@moltzap/protocol/testing";
import {
  CommittedRouterMessage,
  routerSequence,
  type MessageParts,
} from "../../network.js";
import { Effect, Schema } from "effect";
import { assert, describe } from "vitest";
import {
  messageDatabasePathForVolume,
  readCommittedRouterMessages,
} from "./messages.js";

const it = effectIt.scoped;
// A file-backed fixture opens PGlite once to seed and once through the
// production reader while sharing host resources with the Nx test graph.
const PGLITE_TEST_TIMEOUT_MS = 60_000;
const MESSAGE_1 = messageId("00000000-0000-4000-8000-000000000201");
const MESSAGE_2 = messageId("00000000-0000-4000-8000-000000000202");
const decodeConversationId = Schema.decodeUnknownSync(ConversationId);
const CONVERSATION_1 = decodeConversationId(
  "00000000-0000-4000-8000-000000000401",
);
const CONVERSATION_2 = decodeConversationId(
  "00000000-0000-4000-8000-000000000402",
);
const SENDER_1 = agentId("00000000-0000-4000-8000-000000000501");
const SENDER_2 = agentId("00000000-0000-4000-8000-000000000502");
const BODY_1: MessageParts = [{ type: "text", text: "first body" }];
const BODY_2: MessageParts = [{ type: "text", text: "second body" }];
const BODY_1_JSON = JSON.stringify(BODY_1);
const BODY_2_JSON = JSON.stringify(BODY_2);
// The parts schema admits at most ten parts, so an eleventh is a rejection at
// the SQL boundary rather than a truncation.
const OVERSIZED_BODY_JSON = JSON.stringify(
  [...Array.from({ length: 11 }).keys()].map((index) => ({
    type: "text",
    text: `part ${String(index)}`,
  })),
);
const CREATED_AT_1 = "2026-01-01T00:00:01.000Z";
const CREATED_AT_2 = "2026-01-01T00:00:02.000Z";
const CREATED_AT_MILLIS_1 = Date.parse(CREATED_AT_1);
const CREATED_AT_MILLIS_2 = Date.parse(CREATED_AT_2);

const MESSAGES_DDL = `
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    seq BIGINT NOT NULL,
    parts JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  )
`;

type SeedRow = readonly [
  messageId: string,
  conversationId: string,
  senderId: string,
  sequence: number,
  parts: string,
  createdAt: string,
];

const VALID_ROWS: readonly SeedRow[] = [
  [MESSAGE_2, CONVERSATION_2, SENDER_2, 2, BODY_2_JSON, CREATED_AT_2],
  [MESSAGE_1, CONVERSATION_1, SENDER_1, 1, BODY_1_JSON, CREATED_AT_1],
];

const EXPECTED_MESSAGES = [
  CommittedRouterMessage.make({
    messageId: MESSAGE_1,
    conversationId: CONVERSATION_1,
    senderId: SENDER_1,
    routerSequence: routerSequence(1),
    parts: BODY_1,
    createdAtMillis: CREATED_AT_MILLIS_1,
  }),
  CommittedRouterMessage.make({
    messageId: MESSAGE_2,
    conversationId: CONVERSATION_2,
    senderId: SENDER_2,
    routerSequence: routerSequence(2),
    parts: BODY_2,
    createdAtMillis: CREATED_AT_MILLIS_2,
  }),
];

async function seedMessages(
  dataDir: string,
  rows: readonly SeedRow[],
): Promise<undefined> {
  const db = new PGlite(dataDir);
  try {
    await db.exec(MESSAGES_DDL);
    for (const row of rows) {
      await db.query(
        "INSERT INTO messages (id, conversation_id, sender_id, seq, parts, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [...row],
      );
    }
  } finally {
    await db.close();
  }
}

const readSeededMessages = (prefix: string, rows: readonly SeedRow[]) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const volumePath = yield* fileSystem.makeTempDirectoryScoped({ prefix });
    const databasePath = messageDatabasePathForVolume(volumePath);
    yield* Effect.tryPromise(() => seedMessages(databasePath, rows));
    return yield* readCommittedRouterMessages(databasePath);
  }).pipe(Effect.provide(NodeContext.layer));

const assertRejection = (pattern: RegExp) => (failure: unknown) =>
  Effect.sync(() => {
    assert.match(String(failure), pattern);
  });

describe("committed-message projection", () => {
  it(
    "reads committed message bodies in sequence order",
    () =>
      readSeededMessages("moltzap-pglite-", VALID_ROWS).pipe(
        Effect.tap((messages) =>
          Effect.sync(() => {
            assert.deepStrictEqual(messages, EXPECTED_MESSAGES);
          }),
        ),
      ),
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    "rejects an invalid router sequence at the SQL boundary",
    () =>
      readSeededMessages("moltzap-pglite-invalid-", [
        [MESSAGE_1, CONVERSATION_1, SENDER_1, -1, BODY_1_JSON, CREATED_AT_1],
      ]).pipe(
        Effect.flip,
        Effect.tap(assertRejection(/RouterSequence|non-negative/u)),
      ),
    PGLITE_TEST_TIMEOUT_MS,
  );

  it(
    "rejects a malformed parts row at the SQL boundary",
    () =>
      readSeededMessages("moltzap-pglite-parts-", [
        [
          MESSAGE_1,
          CONVERSATION_1,
          SENDER_1,
          1,
          OVERSIZED_BODY_JSON,
          CREATED_AT_1,
        ],
      ]).pipe(
        Effect.flip,
        Effect.tap(assertRejection(/parts|maxItems|at most/u)),
      ),
    PGLITE_TEST_TIMEOUT_MS,
  );
});

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type, agent-code-guard/no-raw-sql, sonarjs/assertions-in-tests, max-nested-callbacks -- Restore strict defaults after the scoped file-level exception. */
