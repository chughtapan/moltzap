/**
 * @file Pins the message store reader to the committed-message identity
 * projection. The fixture intentionally has no payload, timestamp, deletion,
 * reply, encryption, or dispatch columns.
 */
/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type, agent-code-guard/no-raw-sql, sonarjs/assertions-in-tests, max-nested-callbacks -- PGlite exposes a promise-native fixture API; fixture SQL and Effect-wrapped assertions are local to this projection regression. */
// @agent-code-guard/regression-only: the minimal table shape is the invariant under test
import { FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it as effectIt } from "@effect/vitest";
import { PGlite } from "@electric-sql/pglite";
import { agentId, conversationId, messageId } from "@moltzap/protocol/testing";
import { CommittedRouterMessage, routerSequence } from "../../network.js";
import { Effect } from "effect";
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
const CONVERSATION_1 = conversationId("00000000-0000-4000-8000-000000000401");
const CONVERSATION_2 = conversationId("00000000-0000-4000-8000-000000000402");
const SENDER_1 = agentId("00000000-0000-4000-8000-000000000501");
const SENDER_2 = agentId("00000000-0000-4000-8000-000000000502");

const MESSAGES_DDL = `
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    seq BIGINT NOT NULL
  )
`;

type SeedRow = readonly [
  messageId: string,
  conversationId: string,
  senderId: string,
  sequence: number,
];

const VALID_ROWS: readonly SeedRow[] = [
  [MESSAGE_2, CONVERSATION_2, SENDER_2, 2],
  [MESSAGE_1, CONVERSATION_1, SENDER_1, 1],
];

const EXPECTED_MESSAGES = [
  CommittedRouterMessage.make({
    messageId: MESSAGE_1,
    conversationId: CONVERSATION_1,
    senderId: SENDER_1,
    routerSequence: routerSequence(1),
  }),
  CommittedRouterMessage.make({
    messageId: MESSAGE_2,
    conversationId: CONVERSATION_2,
    senderId: SENDER_2,
    routerSequence: routerSequence(2),
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
        "INSERT INTO messages (id, conversation_id, sender_id, seq) VALUES ($1, $2, $3, $4)",
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

describe("committed-message projection", () => {
  it(
    "reads only committed-message identity in sequence order",
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
        [MESSAGE_1, CONVERSATION_1, SENDER_1, -1],
      ]).pipe(
        Effect.flip,
        Effect.tap((failure) =>
          Effect.sync(() => {
            assert.match(String(failure), /RouterSequence|non-negative/u);
          }),
        ),
      ),
    PGLITE_TEST_TIMEOUT_MS,
  );
});

/* eslint-enable agent-code-guard/async-keyword, agent-code-guard/promise-type, agent-code-guard/no-raw-sql, sonarjs/assertions-in-tests, max-nested-callbacks -- Restore strict defaults after the scoped file-level exception. */
