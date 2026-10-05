/**
 * @file Endpoint store fixtures: per-test state directories, scoped store
 * access, and a rewind of a closed store to an earlier schema version so a
 * test can reopen it through the upgrade.
 */

import { Effect } from "effect";
// eslint-disable-next-line agent-code-guard/prefer-effect-platform -- Store tests create and remove real SQLite state directories around independent Effect scopes.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { onTestFinished } from "vitest";
import {
  type EndpointStore,
  type EndpointStoreError,
  openEndpointStore,
} from "../store/index.js";

/**
 * A new empty state directory, removed when the running test finishes; only a
 * test body may call it.
 */
export function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "moltzap-store-"));
  onTestFinished(() => {
    rmSync(directory, { recursive: true, force: true });
  });
  return directory;
}

/** Run `use` against the store in `directory`, opened for that call alone and closed before the result returns. */
export function withStore<Value, Failure>(
  directory: string,
  use: (store: EndpointStore) => Effect.Effect<Value, Failure>,
): Effect.Effect<Value, Failure | EndpointStoreError> {
  return Effect.scoped(openEndpointStore(directory).pipe(Effect.flatMap(use)));
}

/**
 * Rewind the closed store in `directory` to schema version 2 by dropping the
 * runtime tables the version 2 to 3 upgrade creates. Protocol state and the
 * bound identity stay, so the next open upgrades a store that already holds
 * them.
 * @param directory The state directory of a store no scope holds open.
 * @returns Completion once the database reads as version 2.
 */
export const downgradeToSchemaV2 = (directory: string): Effect.Effect<void> =>
  Effect.sync(() => {
    const database = new DatabaseSync(databasePath(directory));
    database.exec(
      "DROP TABLE runtime_inbox; DROP TABLE runtime_sends; DROP TABLE runtime_events; DROP TABLE runtime_legacy_deliveries; PRAGMA user_version = 2",
    );
    database.close();
  });

/** The SQLite file the endpoint store keeps inside a state directory. */
export function databasePath(directory: string): string {
  return join(directory, "moltzapd.sqlite3");
}

/** UTF-8 bytes of `value`, the form the store's canonical columns hold. */
export function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}
