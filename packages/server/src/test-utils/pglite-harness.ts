/**
 * In-memory Postgres harness for service-level unit tests. PGlite gives
 * us the real Postgres SQL surface (CTEs, ON CONFLICT, RETURNING, etc.)
 * without testcontainers boot time, so service tests don't pay the
 * 10-second container cost the integration suite pays.
 *
 * Replaces the per-test-file copies of `async function freshDb()` that
 * had drifted across service tests and `db/schema-migration.test.ts`. One
 * implementation, one place to fix.
 *
 * Returns an Effect so test setup stays inside the same error/cleanup model
 * as the services under test.
 */
import { Data, Effect } from "effect";
import { KyselyPGlite } from "kysely-pglite";
import { makeEffectKysely, type Database, type EffectKysely } from "#db";
import {
  loadCoreSchemaSql,
  type CoreSchemaSqlLoadError,
} from "./core-schema-sql.js";

/** Suggested timeout for pglite-backed beforeEach/afterEach hooks. */
export const PGLITE_HOOK_TIMEOUT_MS = 30_000;

class PgliteCreateError extends Data.TaggedError("PgliteCreateError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

class PgliteExecError extends Data.TaggedError("PgliteExecError")<{
  readonly message: string;
  readonly sqlPreview: string;
  readonly cause?: unknown;
}> {}

class PgliteCloseError extends Data.TaggedError("PgliteCloseError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Represents pglite harness error conditions. */
export type PgliteHarnessError =
  | CoreSchemaSqlLoadError
  | PgliteCreateError
  | PgliteExecError
  | PgliteCloseError;

const SQL_PREVIEW_MAX_CHARS = 160;

function sqlPreview(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().slice(0, SQL_PREVIEW_MAX_CHARS);
}

/** Describes pglite harness. */
export interface PgliteHarness {
  /** Effect-Kysely-wrapped client. Yieldable as Effect via the toolkit. */
  readonly db: EffectKysely<Database>;

  /**
   * Run raw SQL. The harness uses this to load the schema; tests can use it
   * to seed extra rows after `make()` returns.
   */
  readonly exec: (sql: string) => Effect.Effect<unknown, PgliteExecError>;

  /** Tear down the in-memory instance. Call from `afterEach`. */
  readonly close: Effect.Effect<void, PgliteCloseError>;
}

/**
 * Spin up a fresh PGlite instance with the core schema loaded.
 * @returns The created pglite harness.
 */
export function makePgliteHarness(): Effect.Effect<
  PgliteHarness,
  PgliteHarnessError
> {
  return Effect.gen(function* () {
    const kpg = yield* Effect.tryPromise({
      try: () => KyselyPGlite.create(),
      catch: (cause) =>
        new PgliteCreateError({
          message: "Unable to create PGlite instance",
          cause,
        }),
    });
    const exec = (sql: string): Effect.Effect<unknown, PgliteExecError> =>
      Effect.tryPromise({
        try: () => kpg.client.exec(sql),
        catch: (cause) =>
          new PgliteExecError({
            message: "PGlite SQL execution failed",
            sqlPreview: sqlPreview(sql),
            cause,
          }),
      });
    const close = Effect.tryPromise({
      try: () => kpg.client.close(),
      catch: (cause) =>
        new PgliteCloseError({
          message: "PGlite instance close failed",
          cause,
        }),
    });
    const db = makeEffectKysely<Database>({ dialect: kpg.dialect });
    const schema = yield* loadCoreSchemaSql();
    yield* exec(schema);
    return { db, exec, close };
  }).pipe(Effect.withSpan("makePgliteHarness"));
}
