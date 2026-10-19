/** @file Forward-only SQLite upgrades and durable, replaceable pre-upgrade backups. */

import type { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  renameSync,
  rmSync,
} from "node:fs";
import { StoreSignal } from "./values.js";

/** Lowest schema admitted to forward upgrades; raising it establishes a reset boundary. */
export const RESET_SCHEMA = 8;

/** Destination schema numbers map to the one step from their immediate predecessor. */
export const migrations: Readonly<
  Record<number, (database: DatabaseSync) => void>
> = {};

/**
 * Publishes a fresh backup before committing each numbered step independently.
 * Missing steps fail before backup publication, and failed steps retain their predecessor.
 * @param database Exclusively owned endpoint database.
 * @param from Persisted schema number already admitted by preflight.
 * @param databasePath Absolute database filename used for adjacent backups.
 */
export function migrateStore(
  database: DatabaseSync,
  from: number,
  databasePath: string,
): void {
  const target = Math.max(RESET_SCHEMA, ...Object.keys(migrations).map(Number));
  for (let version = from + 1; version <= target; version += 1) {
    if (migrations[version] === undefined) {
      throw new StoreSignal("incompatible");
    }
  }
  writeBackup(database, from, databasePath);
  for (let version = from + 1; version <= target; version += 1) {
    const step = migrations[version];
    if (step === undefined) {
      throw new StoreSignal("incompatible");
    }
    database.exec("BEGIN EXCLUSIVE");
    try {
      step(database);
      database.exec(`PRAGMA user_version = ${version}`);
      database.exec("COMMIT");
    } catch (failure) {
      database.exec("ROLLBACK");
      throw failure;
    }
  }
}

function writeBackup(
  database: DatabaseSync,
  from: number,
  databasePath: string,
): void {
  const backup = `${databasePath}.schema-${from}.backup`;
  const temporary = `${backup}.tmp`;
  rmSync(temporary, { force: true });
  const descriptor = openSync(temporary, "wx", 0o600);
  try {
    database.prepare("VACUUM INTO ?").run(temporary);
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, backup);
}
