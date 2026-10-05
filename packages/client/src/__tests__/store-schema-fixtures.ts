/** @file Rewinds a closed endpoint store to an earlier schema version, so a test can reopen it through the upgrade. */

import { Effect } from "effect";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
    const database = new DatabaseSync(join(directory, "moltzapd.sqlite3"));
    database.exec(
      "DROP TABLE runtime_inbox; DROP TABLE runtime_sends; DROP TABLE runtime_events; DROP TABLE runtime_legacy_deliveries; PRAGMA user_version = 2",
    );
    database.close();
  });
