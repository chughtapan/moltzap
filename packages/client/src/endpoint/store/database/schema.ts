/** @file SQLite ownership, exact-version preflight, and closed persistence primitives. */

import { Effect } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Ownership requires synchronous permission changes before the database escapes acquisition.
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CertifiedRecord } from "../types.js";
import {
  type EndpointStoreError,
  mapStoreFailure,
  readInteger,
  readText,
  requireText,
  StoreSignal,
} from "./values.js";

/** One process-local frozen management read. */
export interface HistorySnapshot {
  readonly records: readonly CertifiedRecord[];
  readonly offset: number;
}

/** Exclusive SQLite state retained for one Effect scope. */
export interface StoreState {
  readonly database: DatabaseSync;
  readonly snapshots: Map<string, HistorySnapshot>;
  closed: boolean;
}

const DATABASE_NAME = "moltzapd.sqlite3";
const SCHEMA_VERSION = 2;

type PreflightDisposition = "initialize" | "reopen";

/**
 * Acquires and exclusively locks one exact-version endpoint database.
 * @param stateDirectory Exclusive persistent state directory.
 * @returns Acquired database state after integrity and compatibility checks.
 */
export const openStoreState = (
  stateDirectory: string,
): Effect.Effect<StoreState, EndpointStoreError> =>
  Effect.try({
    try: () => initializeStoreState(stateDirectory),
    catch: (failure) => mapStoreFailure(failure, "persistence"),
  });

/**
 * Closes exactly the SQLite and volatile snapshot state in this scope.
 * @param state Acquired database and process-local snapshots.
 * @returns An infallible finalizer effect.
 */
export const closeStoreState = (state: StoreState): Effect.Effect<void> =>
  Effect.sync(() => {
    if (state.closed) {
      return;
    }
    state.closed = true;
    state.snapshots.clear();
    try {
      state.database.close();
      // eslint-disable-next-line agent-code-guard/bare-catch -- Finalization must remain infallible and disclose no SQLite diagnostic. #ignore-sloppy-code-next-line[bare-catch]: Store finalization preserves its infallible persistence boundary.
    } catch {
      // Scope finalization cannot disclose or override the operation result.
    }
  });

/**
 * Converts a synchronous store operation into the closed Effect channel.
 * @param state Acquired database and process-local snapshots.
 * @param operation Synchronous operation inside the ownership boundary.
 * @returns The operation in the closed store error channel.
 */
export function runStoreOperation<Value>(
  state: StoreState,
  operation: () => Value,
): Effect.Effect<Value, EndpointStoreError> {
  return Effect.try({
    try: () => {
      if (state.closed) {
        throw new StoreSignal("closed");
      }
      return operation();
    },
    catch: (failure) => mapStoreFailure(failure, "persistence"),
  });
}

/**
 * Runs one non-yielding SQLite transaction and preserves its first failure.
 * @param database Exclusively owned endpoint database.
 * @param operation Non-yielding transition to commit atomically.
 * @param mode SQLite write-lock mode.
 * @returns The committed transition result.
 */
export function transaction<Value>(
  database: DatabaseSync,
  operation: () => Value,
  mode: "IMMEDIATE" | "EXCLUSIVE" = "IMMEDIATE",
): Value {
  database.exec(`BEGIN ${mode}`);
  try {
    const value = operation();
    database.exec("COMMIT");
    return value;
  } catch (failure) {
    try {
      database.exec("ROLLBACK");
      // eslint-disable-next-line agent-code-guard/bare-catch -- Rollback failure cannot replace or expose the original failure. #ignore-sloppy-code-next-line[bare-catch]: The original persistence failure remains authoritative.
    } catch {
      // The original closed failure remains authoritative.
    }
    throw failure;
  }
}

function initializeStoreState(stateDirectory: string): StoreState {
  requireText(stateDirectory);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const databasePath = resolve(stateDirectory, DATABASE_NAME);
  const expected = existsSync(databasePath)
    ? inspectExistingDatabase(databasePath)
    : undefined;
  let database: DatabaseSync | undefined;
  try {
    database = openWritableDatabase(databasePath);
    const disposition = preflightDatabase(database);
    if (expected !== undefined && disposition !== expected) {
      throw new StoreSignal("incompatible");
    }
    chmodSync(stateDirectory, 0o700);
    chmodSync(databasePath, 0o600);
    configureDatabase(database);
    if (disposition === "initialize") {
      initializeDatabase(database);
    }
    return { database, snapshots: new Map(), closed: false };
  } catch (failure) {
    try {
      database?.close();
      // eslint-disable-next-line agent-code-guard/bare-catch -- Failed acquisition closes best-effort without replacing the startup failure. #ignore-sloppy-code-next-line[bare-catch]: The original persistence startup failure remains authoritative.
    } catch {
      // Initialization reports only the original closed failure category.
    }
    throw failure;
  }
}

function inspectExistingDatabase(databasePath: string): PreflightDisposition {
  const database = new DatabaseSync(databasePath, {
    readOnly: true,
    enableForeignKeyConstraints: false,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    timeout: 0,
  });
  try {
    return preflightDatabase(database);
  } finally {
    database.close();
  }
}

function openWritableDatabase(databasePath: string): DatabaseSync {
  return new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    timeout: 0,
  });
}

function preflightDatabase(database: DatabaseSync): PreflightDisposition {
  const versionRow = database.prepare("PRAGMA user_version").get();
  if (versionRow === undefined) {
    throw new StoreSignal("corrupt");
  }
  const version = readInteger(versionRow, "user_version");
  if (version !== 0 && version !== SCHEMA_VERSION) {
    throw new StoreSignal("incompatible");
  }
  if (version === 0) {
    if (hasUserSchemaObjects(database)) {
      throw new StoreSignal("incompatible");
    }
    requireHealthyDatabase(database);
    return "initialize";
  }
  requireHealthyDatabase(database);
  return "reopen";
}

function hasUserSchemaObjects(database: DatabaseSync): boolean {
  return (
    database
      .prepare(
        `SELECT 1 AS retained FROM sqlite_schema
         WHERE type IN ('table', 'index', 'view', 'trigger')
           AND name NOT LIKE 'sqlite_%'
         LIMIT 1`,
      )
      .get() !== undefined
  );
}

function requireHealthyDatabase(database: DatabaseSync): void {
  const check = database.prepare("PRAGMA quick_check").all();
  const checkRow = check[0];
  if (
    check.length !== 1 ||
    checkRow === undefined ||
    readText(checkRow, "quick_check") !== "ok"
  ) {
    throw new StoreSignal("corrupt");
  }
}

function configureDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA busy_timeout = 0");
  database.exec("PRAGMA foreign_keys = ON");
  const journal = database.prepare("PRAGMA journal_mode = WAL").get();
  const locking = database.prepare("PRAGMA locking_mode = EXCLUSIVE").get();
  database.exec("PRAGMA synchronous = FULL");
  const foreignKeys = database.prepare("PRAGMA foreign_keys").get();
  const synchronous = database.prepare("PRAGMA synchronous").get();
  requireTextPragma("journal_mode", "wal", journal);
  requireTextPragma("locking_mode", "exclusive", locking);
  requireIntegerPragma("foreign_keys", 1, foreignKeys);
  requireIntegerPragma("synchronous", 2, synchronous);
}

function requireTextPragma(
  key: string,
  expected: string,
  row?: Readonly<Record<string, unknown>>,
): void {
  if (row === undefined) {
    throw new StoreSignal("persistence");
  }
  if (readText(row, key) !== expected) {
    throw new StoreSignal("persistence");
  }
}

function requireIntegerPragma(
  key: string,
  expected: number,
  row?: Readonly<Record<string, unknown>>,
): void {
  if (row === undefined) {
    throw new StoreSignal("persistence");
  }
  if (readInteger(row, key) !== expected) {
    throw new StoreSignal("persistence");
  }
}

const schemaSql = `
  CREATE TABLE identity_binding (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    agent_id TEXT NOT NULL,
    canonical_agent_card BLOB NOT NULL
  ) STRICT;
  CREATE TABLE post_intents (
    author_agent_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    membership_hash TEXT NOT NULL,
    canonical_intent BLOB NOT NULL,
    completed_record_hash TEXT,
    PRIMARY KEY (author_agent_id, post_id),
    FOREIGN KEY (conversation_id, membership_hash)
      REFERENCES memberships(conversation_id, membership_hash)
  ) STRICT;
  CREATE TABLE memberships (
    conversation_id TEXT PRIMARY KEY,
    membership_hash TEXT NOT NULL,
    canonical_membership BLOB NOT NULL,
    UNIQUE (conversation_id, membership_hash)
  ) STRICT;
  CREATE TABLE anchors (
    conversation_id TEXT NOT NULL REFERENCES memberships(conversation_id),
    anchor_hash TEXT NOT NULL,
    previous_anchor_hash TEXT,
    selected_record_hash TEXT,
    canonical_anchor BLOB NOT NULL,
    PRIMARY KEY (conversation_id, anchor_hash)
  ) STRICT;
  CREATE TABLE conversation_state (
    conversation_id TEXT PRIMARY KEY REFERENCES memberships(conversation_id),
    membership_hash TEXT NOT NULL,
    current_anchor_hash TEXT NOT NULL,
    head_record_hash TEXT,
    head_ordinal INTEGER NOT NULL CHECK (head_ordinal >= -1),
    FOREIGN KEY (conversation_id, current_anchor_hash)
      REFERENCES anchors(conversation_id, anchor_hash)
  ) STRICT;
  CREATE TABLE proposal_locks (
    conversation_id TEXT NOT NULL REFERENCES memberships(conversation_id),
    predecessor_key TEXT NOT NULL,
    previous_record_hash TEXT,
    action_hash TEXT NOT NULL,
    canonical_action_core BLOB NOT NULL,
    PRIMARY KEY (conversation_id, predecessor_key),
    CHECK (
      (previous_record_hash IS NULL AND predecessor_key = '') OR
      (previous_record_hash IS NOT NULL AND predecessor_key = previous_record_hash)
    )
  ) STRICT;
  CREATE TABLE staged_records (
    conversation_id TEXT NOT NULL REFERENCES memberships(conversation_id),
    record_hash TEXT NOT NULL,
    previous_record_hash TEXT,
    membership_hash TEXT NOT NULL,
    anchor_hash TEXT NOT NULL,
    action_hash TEXT NOT NULL,
    author_agent_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    canonical_record_core BLOB NOT NULL,
    PRIMARY KEY (conversation_id, record_hash),
    FOREIGN KEY (conversation_id, anchor_hash)
      REFERENCES anchors(conversation_id, anchor_hash)
  ) STRICT;
  CREATE TABLE protocol_evidence (
    conversation_id TEXT NOT NULL REFERENCES memberships(conversation_id),
    evidence_kind TEXT NOT NULL CHECK (
      evidence_kind IN ('action', 'durability', 'catch-up', 'reanchor')
    ),
    subject_id TEXT NOT NULL,
    evidence_key TEXT NOT NULL,
    canonical_evidence BLOB NOT NULL,
    PRIMARY KEY (conversation_id, evidence_kind, subject_id, evidence_key)
  ) STRICT;
  CREATE TABLE certified_records (
    conversation_id TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    PRIMARY KEY (conversation_id, record_hash),
    UNIQUE (conversation_id, ordinal),
    FOREIGN KEY (conversation_id, record_hash)
      REFERENCES staged_records(conversation_id, record_hash)
  ) STRICT;
  CREATE TABLE reanchors (
    conversation_id TEXT NOT NULL REFERENCES memberships(conversation_id),
    anchor_hash TEXT NOT NULL,
    previous_anchor_hash TEXT NOT NULL,
    router_instance_id TEXT NOT NULL,
    selected_record_hash TEXT NOT NULL,
    canonical_body BLOB NOT NULL,
    canonical_completed_reanchor BLOB,
    PRIMARY KEY (conversation_id, anchor_hash),
    UNIQUE (conversation_id, previous_anchor_hash, router_instance_id),
    FOREIGN KEY (conversation_id, previous_anchor_hash)
      REFERENCES anchors(conversation_id, anchor_hash),
    FOREIGN KEY (conversation_id, selected_record_hash)
      REFERENCES certified_records(conversation_id, record_hash)
  ) STRICT;
  CREATE TABLE pending_deliveries (
    delivery_sequence INTEGER PRIMARY KEY,
    delivery_token TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    recipient_agent_id TEXT NOT NULL,
    canonical_message BLOB NOT NULL,
    acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1)),
    UNIQUE (conversation_id, record_hash, recipient_agent_id),
    FOREIGN KEY (conversation_id, record_hash)
      REFERENCES certified_records(conversation_id, record_hash)
  ) STRICT;
  CREATE TABLE outbound_messages (
    outbound_sequence INTEGER PRIMARY KEY,
    outbound_id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES memberships(conversation_id),
    current_message_id TEXT NOT NULL UNIQUE,
    canonical_initial_signed_message BLOB NOT NULL,
    canonical_current_signed_message BLOB NOT NULL,
    attempted INTEGER NOT NULL CHECK (attempted IN (0, 1)),
    disposition TEXT NOT NULL CHECK (
      disposition IN ('pending', 'accepted', 'discarded')
    )
  ) STRICT;
  CREATE TABLE dissemination_obligations (
    obligation_sequence INTEGER PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    packet_kind TEXT NOT NULL CHECK (
      packet_kind IN ('action-certified-record', 'certified-record')
    ),
    outbound_id TEXT UNIQUE,
    UNIQUE (conversation_id, record_hash, packet_kind),
    FOREIGN KEY (conversation_id, record_hash)
      REFERENCES staged_records(conversation_id, record_hash),
    FOREIGN KEY (outbound_id) REFERENCES outbound_messages(outbound_id)
  ) STRICT;
`;

function initializeDatabase(database: DatabaseSync): void {
  transaction(
    database,
    () => {
      database.exec(schemaSql);
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    },
    "EXCLUSIVE",
  );
}
