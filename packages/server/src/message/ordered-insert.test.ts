/* eslint-disable @typescript-eslint/no-invalid-void-type, @typescript-eslint/parameter-properties, @typescript-eslint/require-await, agent-code-guard/async-keyword, agent-code-guard/max-non-trivial-classes-per-file, agent-code-guard/no-promise-all-in-effect, agent-code-guard/prefer-effect-platform, agent-code-guard/promise-type, agent-code-guard/then-chain -- Kysely's Driver contract is Promise-native; this controlled test driver mirrors that boundary to make transaction scheduling observable. */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type QueryResult,
} from "kysely";
import { agentId, conversationId, messageId } from "@moltzap/protocol/testing";
import type { ConversationId } from "@moltzap/protocol/conversation";
import { type Database, type MessageRow, makeEffectKysely } from "#db";
import { insertMessageInCheckpointOrder } from "./message.service.js";

const CONVERSATION_ID = conversationId("00000000-0000-4000-8000-00000000c001");
const OTHER_CONVERSATION_ID = conversationId(
  "00000000-0000-4000-8000-00000000c002",
);
const SENDER_ID = agentId("00000000-0000-4000-8000-00000000a001");
const FIRST_MESSAGE_ID = messageId("00000000-0000-4000-8000-00000000e001");
const SECOND_MESSAGE_ID = messageId("00000000-0000-4000-8000-00000000e002");
const MESSAGE_PARTS = JSON.stringify([{ type: "text", text: "ordered" }]);
const CREATED_AT = new Date("2026-08-11T00:00:00.000Z");
const BLOCKED = "blocked";
const INSERTED = "inserted";
const ROLLED_BACK = "rolled-back";
const EXPECTED_SEQUENCES = ["1", "2"];
const POST_ROLLBACK_SEQUENCE = "2";

interface Gate {
  readonly promise: Promise<void>;
  readonly open: () => void;
}

function makeGate(): Gate {
  let openGate: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    openGate = () => {
      resolve();
    };
  });
  return {
    promise,
    open: () => {
      openGate?.();
    },
  };
}

class ControlledConnection implements DatabaseConnection {
  conversationId?: ConversationId;

  constructor(
    private readonly driver: OrderingDriver,
    readonly writer: number,
  ) {}

  executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    return this.driver.execute(this, query);
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {}
}

class OrderingDriver implements Driver {
  readonly firstInsertReached = makeGate();
  readonly allowFirstInsert = makeGate();
  readonly secondLockBlocked = makeGate();
  readonly secondInsertReached = makeGate();
  private readonly failFirstInsert: boolean;
  private readonly locks = new Map<
    ConversationId,
    { readonly owner: ControlledConnection; readonly released: Gate }
  >();
  private connectionCount = 0;
  private sequence = 0;

  constructor(options: { readonly failFirstInsert?: boolean } = {}) {
    this.failFirstInsert = options.failFirstInsert ?? false;
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    this.connectionCount += 1;
    return new ControlledConnection(this, this.connectionCount);
  }

  async beginTransaction(): Promise<void> {}

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    this.releaseLock(connection);
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    this.releaseLock(connection);
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {}

  async execute<R>(
    connection: ControlledConnection,
    query: CompiledQuery,
  ): Promise<QueryResult<R>> {
    if (query.sql.startsWith("select")) {
      const lockedConversationId = conversationId(String(query.parameters[0]));
      connection.conversationId = lockedConversationId;
      if (query.sql.includes("for update")) {
        await this.acquireLock(connection, lockedConversationId);
      }
      return this.result<R>({ id: lockedConversationId });
    }
    if (query.sql.startsWith('insert into "messages"')) {
      return await this.insert<R>(connection);
    }
    throw new Error(`Unexpected query: ${query.sql}`);
  }

  private async acquireLock(
    connection: ControlledConnection,
    lockedConversationId: ConversationId,
  ): Promise<void> {
    const current = this.locks.get(lockedConversationId);
    if (current !== undefined && current.owner !== connection) {
      this.secondLockBlocked.open();
      await current.released.promise;
    }
    this.locks.set(lockedConversationId, {
      owner: connection,
      released: makeGate(),
    });
  }

  private async insert<R>(
    connection: ControlledConnection,
  ): Promise<QueryResult<R>> {
    this.sequence += 1;
    const seq = this.sequence.toString();
    if (connection.writer === 1) {
      this.firstInsertReached.open();
      await this.allowFirstInsert.promise;
      if (this.failFirstInsert) {
        throw new Error("Controlled first insert rollback");
      }
    } else {
      this.secondInsertReached.open();
    }
    return this.result<R>(this.messageRow(connection, seq));
  }

  private releaseLock(connection: DatabaseConnection): void {
    if (!(connection instanceof ControlledConnection)) {
      return;
    }
    const lockedConversationId = connection.conversationId;
    if (lockedConversationId === undefined) {
      return;
    }
    const current = this.locks.get(lockedConversationId);
    if (current?.owner === connection) {
      current.released.open();
      this.locks.delete(lockedConversationId);
    }
  }

  private messageRow(
    connection: ControlledConnection,
    seq: string,
  ): MessageRow {
    if (connection.conversationId === undefined) {
      throw new Error("Controlled insert requires a conversation lock query");
    }
    return {
      id: connection.writer === 1 ? FIRST_MESSAGE_ID : SECOND_MESSAGE_ID,
      conversation_id: connection.conversationId,
      sender_id: SENDER_ID,
      seq,
      parts: MESSAGE_PARTS,
      is_deleted: false,
      created_at: CREATED_AT,
    };
  }

  private result<R>(row: object): QueryResult<R> {
    return {
      rows: [
        /* Safe because the controlled driver returns the row shape requested by each recognized query. */
        row as R,
      ],
    };
  }
}

function insert(
  db: ReturnType<typeof makeEffectKysely<Database>>,
  id: string,
  targetConversationId: ConversationId = CONVERSATION_ID,
) {
  return Effect.runPromise(
    insertMessageInCheckpointOrder(db, {
      id: messageId(id),
      conversationId: targetConversationId,
      senderAgentId: SENDER_ID,
      parts: MESSAGE_PARTS,
      createdAt: CREATED_AT,
    }),
  );
}

function makeDb(driver: OrderingDriver) {
  return makeEffectKysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (database) => new PostgresIntrospector(database),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

async function blocksSameConversationWriter() {
  const driver = new OrderingDriver();
  const db = makeDb(driver);

  const first = insert(db, FIRST_MESSAGE_ID);
  await driver.firstInsertReached.promise;
  const second = insert(db, SECOND_MESSAGE_ID);
  const outcome = await Promise.race([
    driver.secondLockBlocked.promise.then(() => BLOCKED),
    driver.secondInsertReached.promise.then(() => INSERTED),
  ]);

  driver.allowFirstInsert.open();
  const rows = await Promise.all([first, second]);
  await db.destroy();

  expect(outcome).toBe(BLOCKED);
  expect(rows.map((row) => row.seq)).toEqual(EXPECTED_SEQUENCES);
}

async function permitsUnrelatedConversationWriter() {
  const driver = new OrderingDriver();
  const db = makeDb(driver);

  const first = insert(db, FIRST_MESSAGE_ID);
  await driver.firstInsertReached.promise;
  const second = insert(db, SECOND_MESSAGE_ID, OTHER_CONVERSATION_ID);
  const outcome = await Promise.race([
    driver.secondInsertReached.promise.then(() => INSERTED),
    driver.secondLockBlocked.promise.then(() => BLOCKED),
  ]);

  driver.allowFirstInsert.open();
  await Promise.all([first, second]);
  await db.destroy();

  expect(outcome).toBe(INSERTED);
}

async function releasesLockAfterRollback() {
  const driver = new OrderingDriver({ failFirstInsert: true });
  const db = makeDb(driver);

  const first = insert(db, FIRST_MESSAGE_ID).then(
    () => INSERTED,
    () => ROLLED_BACK,
  );
  await driver.firstInsertReached.promise;
  const second = insert(db, SECOND_MESSAGE_ID);
  const outcome = await Promise.race([
    driver.secondLockBlocked.promise.then(() => BLOCKED),
    driver.secondInsertReached.promise.then(() => INSERTED),
  ]);

  driver.allowFirstInsert.open();
  const firstOutcome = await first;
  const secondRow = await second;
  await db.destroy();

  expect(outcome).toBe(BLOCKED);
  expect(firstOutcome).toBe(ROLLED_BACK);
  expect(secondRow.seq).toBe(POST_ROLLBACK_SEQUENCE);
}

describe("message checkpoint order", () => {
  it(
    "blocks a later insert until the earlier same-conversation writer commits",
    blocksSameConversationWriter,
  );
  it(
    "allows unrelated conversations to allocate order concurrently",
    permitsUnrelatedConversationWriter,
  );
  it(
    "releases the conversation lock after rollback and tolerates the identity gap",
    releasesLockAfterRollback,
  );
});
/* eslint-enable @typescript-eslint/no-invalid-void-type, @typescript-eslint/parameter-properties, @typescript-eslint/require-await, agent-code-guard/async-keyword, agent-code-guard/max-non-trivial-classes-per-file, agent-code-guard/no-promise-all-in-effect, agent-code-guard/prefer-effect-platform, agent-code-guard/promise-type, agent-code-guard/then-chain -- Restore Effect-first defaults after the controlled Kysely driver boundary. */
