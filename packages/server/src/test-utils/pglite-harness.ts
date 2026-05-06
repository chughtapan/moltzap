/**
 * In-memory Postgres harness for service-level unit tests. PGlite gives
 * us the real Postgres SQL surface (CTEs, ON CONFLICT, RETURNING, etc.)
 * without testcontainers boot time, so service tests don't pay the
 * 10-second container cost the integration suite pays.
 *
 * Replaces the per-test-file copies of `async function freshDb()` that
 * had drifted across `services/{auth,contact,conversation,task}.service.test.ts`
 * and `db/schema-migration.test.ts`. One implementation, one place to fix.
 *
 * Returns a Promise (not an Effect) because vitest hooks
 * (`beforeEach(async () => ...)`) consume Promises directly; an Effect
 * would force every caller to wrap with `Effect.runPromise`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { KyselyPGlite } from "kysely-pglite";
import type { Kysely } from "kysely";
import { makeEffectKysely } from "../db/effect-kysely-toolkit.js";
import type { Database } from "../db/database.js";

/** Suggested timeout for pglite-backed beforeEach/afterEach hooks. */
export const PGLITE_HOOK_TIMEOUT_MS = 30_000;

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(
  join(__dirname, "..", "app", "core-schema.sql"),
  "utf-8",
);

export interface PgliteHarness {
  /** Effect-Kysely-wrapped client. Yieldable as Effect via the toolkit. */
  readonly db: Kysely<Database>;
  /** Run raw SQL — the harness uses this to load the schema; tests can
   *  use it to seed extra rows after `make()` returns. */
  // eslint-disable-next-line agent-code-guard/promise-type -- test plumbing: PGlite client API surface
  readonly exec: (sql: string) => Promise<unknown>;
  /** Tear down the in-memory instance. Call from `afterEach`. */
  // eslint-disable-next-line agent-code-guard/promise-type -- test plumbing: PGlite client API surface
  readonly close: () => Promise<void>;
}

/** Spin up a fresh PGlite instance with the core schema loaded. */
// eslint-disable-next-line agent-code-guard/async-keyword -- test plumbing: vitest hooks expect async callbacks
export async function makePgliteHarness(): // eslint-disable-next-line agent-code-guard/promise-type -- test plumbing: see fn doc
Promise<PgliteHarness> {
  const kpg = await KyselyPGlite.create();
  const exec = (sql: string) => kpg.client.exec(sql);
  const close = () => kpg.client.close();
  const db = makeEffectKysely<Database>({ dialect: kpg.dialect });
  await exec(SCHEMA_SQL);
  return { db, exec, close };
}
