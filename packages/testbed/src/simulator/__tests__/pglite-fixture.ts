/**
 * @file Builds a server-storage PGlite fixture for the drain paths: the
 * `messages` table with the server's column shape (`core-schema.sql`,
 * foreign keys omitted — the drain reads only this table) and rows in
 * the plaintext posture (`dek_version` 0, parts as UTF-8 JSON bytes).
 * Deliberately a plain promise module, isolated like `node-pglite.ts`.
 */
/* eslint-disable agent-code-guard/async-keyword, agent-code-guard/promise-type -- promise-native PGlite fixture builder; the drain paths wrap it in Effect.tryPromise */
import { PGlite } from "@electric-sql/pglite";

export type FixtureMessage = {
  readonly id: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly seq: number;
  readonly replyToId?: string;
  readonly parts: ReadonlyArray<{ type: string; text: string }>;
  readonly dekVersion?: number;
};

const MESSAGES_DDL = `
  CREATE TABLE messages (
    id UUID PRIMARY KEY,
    conversation_id UUID NOT NULL,
    sender_id UUID NOT NULL,
    seq BIGINT NOT NULL,
    reply_to_id UUID,
    parts_encrypted BYTEA NOT NULL,
    parts_iv BYTEA NOT NULL,
    parts_tag BYTEA NOT NULL,
    dek_version INT NOT NULL DEFAULT 1,
    kek_version INT NOT NULL,
    is_deleted BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(conversation_id, seq)
  )
`;

const INSERT_SQL = `
  INSERT INTO messages
    (id, conversation_id, sender_id, seq, reply_to_id,
     parts_encrypted, parts_iv, parts_tag, dek_version, kek_version)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0)
`;

/** Create a PGlite data directory at `dir` holding the given society messages. */
export async function buildMessagesFixture(
  dir: string,
  rows: ReadonlyArray<FixtureMessage>,
): Promise<void> {
  const db = new PGlite(dir);
  try {
    await db.exec(MESSAGES_DDL);
    for (const row of rows) {
      await db.query(INSERT_SQL, [
        row.id,
        row.conversationId,
        row.senderId,
        row.seq,
        row.replyToId ?? null,
        Buffer.from(JSON.stringify(row.parts), "utf8"),
        Buffer.alloc(0),
        Buffer.alloc(0),
        row.dekVersion ?? 0,
      ]);
    }
  } finally {
    await db.close();
  }
}
