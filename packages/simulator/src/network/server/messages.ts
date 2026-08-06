/**
 * @file PGlite traffic reads performed after the MoltZap router stops.
 *
 * PGlite is single-process, so the reader opens the data directory only after
 * the server container has released it.
 */
import * as SqlSchema from "@effect/sql/SqlSchema";
import { SqlError } from "@effect/sql/SqlError";
import { PGlite } from "@electric-sql/pglite";
import { CommittedRouterMessage } from "../router.js";
import { Brand, Effect, Schema, type ParseResult } from "effect";
import { join } from "node:path";

/** PGlite directory below a MoltZap server volume. */
const SERVER_PGLITE_DIR = "pglite";

/** Exact message-store path derived from a server-owned volume. */
export type MessageDatabasePath = string & Brand.Brand<"MessageDatabasePath">;

const MessageDatabasePathBrand = Brand.nominal<MessageDatabasePath>();

/**
 * Derive the exact message store path from a server-owned volume root.
 * @param volumeRoot Value supplied to the operation.
 * @returns The message database path for volume result.
 */
export function messageDatabasePathForVolume(
  volumeRoot: string,
): MessageDatabasePath {
  return MessageDatabasePathBrand(join(volumeRoot, SERVER_PGLITE_DIR));
}

const MESSAGES_QUERY = `
  SELECT
    id AS "messageId",
    conversation_id AS "conversationId",
    sender_id AS "senderId",
    seq::double precision AS "routerSequence"
  FROM messages
  ORDER BY seq
`;

function readRows(
  db: PGlite,
): Effect.Effect<
  readonly CommittedRouterMessage[],
  SqlError | ParseResult.ParseError
> {
  return SqlSchema.findAll({
    Request: Schema.Void,
    Result: CommittedRouterMessage,
    execute: () =>
      Effect.tryPromise({
        try: () => db.query<Record<string, unknown>>(MESSAGES_QUERY),
        catch: (cause) =>
          new SqlError({ cause, message: "read committed messages failed" }),
      }).pipe(Effect.map((result) => result.rows)),
  })(undefined);
}

function closeDatabase(db: PGlite): Effect.Effect<void> {
  return Effect.tryPromise({
    try: () => db.close(),
    catch: (cause) =>
      new SqlError({ cause, message: "close message database failed" }),
  }).pipe(
    Effect.catchAll((failure) =>
      Effect.logWarning("failed to close the message database", failure),
    ),
  );
}

/**
 * Read every persisted society message from a stopped server's data volume.
 * @param databasePath Value supplied to the operation.
 * @returns The read committed router messages result.
 */
export function readCommittedRouterMessages(
  databasePath: MessageDatabasePath,
): Effect.Effect<
  readonly CommittedRouterMessage[],
  SqlError | ParseResult.ParseError
> {
  return Effect.scoped(
    Effect.acquireRelease(
      Effect.try({
        try: () => new PGlite(databasePath),
        catch: (cause) =>
          new SqlError({ cause, message: "open message database failed" }),
      }),
      closeDatabase,
    ).pipe(Effect.flatMap(readRows)),
  );
}
