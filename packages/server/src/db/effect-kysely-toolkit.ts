/**
 * Makes Kysely builders usable as Effects: `yield* qb` instead of
 * `yield* Effect.tryPromise(() => qb.execute())`. Patches the builder
 * prototypes to be Effectable. `@effect/sql-kysely`'s Proxy variant
 * infinite-recurses on `bytea` columns, so we skip it.
 */
import { SqlError } from "@effect/sql/SqlError";
import { Cause, Data, Effect, Effectable, Option } from "effect";
import {
  AlterTableColumnAlteringBuilder,
  CreateIndexBuilder,
  CreateSchemaBuilder,
  CreateTableBuilder,
  CreateTypeBuilder,
  CreateViewBuilder,
  DeleteQueryBuilder,
  DropIndexBuilder,
  DropSchemaBuilder,
  DropTableBuilder,
  DropTypeBuilder,
  DropViewBuilder,
  InsertQueryBuilder,
  Kysely,
  sql,
  UpdateQueryBuilder,
  WheneableMergeQueryBuilder,
  type KyselyConfig,
  type RawBuilder,
  type Transaction,
} from "./kysely-vendor.js";
import type { EffectKysely as SqlEffectKysely } from "@effect/sql-kysely/Pg";

// Pulls in `declare module "kysely"` augmentations so `yield* qb` type-checks.
// TYPE-ONLY import: the runtime module installs a Proxy wrapper that re-wraps
// every returned row value, which causes `Buffer.from(proxy)` on bytea columns
// to infinite-recurse through the get trap. We only want the type augmentations;
// our own prototype patching below provides the runtime bridge.

const ATTR_DB_QUERY_TEXT = "db.query.text";

class KyselyPrototypeMissingError extends Data.TaggedError(
  "KyselyPrototypeMissingError",
)<{ readonly message: string }> {}

/**
 * Builder-as-Effect: when a builder instance is yielded, Effect runtime
 * calls `.commit()` on it. We implement `commit` as a thin wrapper over
 * Kysely's native `.execute()` — that's the only bridge needed.
 *
 * `this` at call time is the real builder instance, so `this.execute()`
 * and `this.compile()` hit Kysely directly with no indirection.
 * @param this Value supplied to the operation.
 * @param this.execute Value supplied to the operation.
 * @param this.compile Value supplied to the operation.
 * @returns The commit via execute result.
 */
function commitViaExecute(this: {
  execute: () => PromiseLike<readonly unknown[]>;
  compile: () => { sql: string };
}): Effect.Effect<readonly unknown[], SqlError> {
  return Effect.tryPromise({
    try: () => this.execute(),
    catch: (cause) => new SqlError({ cause, message: "Kysely query failed" }),
  }).pipe(
    Effect.withSpan("kysely.execute", {
      kind: "client",
      captureStackTrace: false,
      attributes: {
        [ATTR_DB_QUERY_TEXT]: this.compile().sql,
      },
    }),
  );
}

/**
 * Mark a prototype as an Effect that commits via `.execute()`.
 *
 * Always installs `Effectable.CommitPrototype` (making the builder an Effect)
 * and our `commit` method. Safe to call multiple times and safe to call on
 * prototypes that `@effect/sql-kysely` has already patched (we overwrite
 * its dummy commit with the real one).
 * @param prototype Value supplied to the operation.
 */
function patchPrototype(prototype: object): void {
  Object.assign(prototype, Effectable.CommitPrototype);
  (
    /* Safe because the surrounding invariant establishes this asserted shape. */
    prototype as { commit: unknown }
  ).commit = commitViaExecute;
}

// Patch all compilable builder prototypes at module load. `SelectQueryBuilder`
// is not exported from "kysely", so we patch it lazily from an instance below.
patchPrototype(AlterTableColumnAlteringBuilder.prototype);
patchPrototype(CreateIndexBuilder.prototype);
patchPrototype(CreateSchemaBuilder.prototype);
patchPrototype(CreateTableBuilder.prototype);
patchPrototype(CreateTypeBuilder.prototype);
patchPrototype(CreateViewBuilder.prototype);
patchPrototype(DeleteQueryBuilder.prototype);
patchPrototype(DropIndexBuilder.prototype);
patchPrototype(DropSchemaBuilder.prototype);
patchPrototype(DropTableBuilder.prototype);
patchPrototype(DropTypeBuilder.prototype);
patchPrototype(DropViewBuilder.prototype);
patchPrototype(InsertQueryBuilder.prototype);
patchPrototype(UpdateQueryBuilder.prototype);
patchPrototype(WheneableMergeQueryBuilder.prototype);

/**
 * `EffectKysely&lt;DB>` — a Kysely instance whose builders are also Effects.
 *
 * Structurally identical to `Kysely&lt;DB>`; the Effect-capability is added
 * on the builder prototypes. Kept as a separate type alias so call sites
 * that want to be explicit about the capability can signal it.
 */
export type EffectKysely<DB> = Kysely<DB> & Pick<SqlEffectKysely<DB>, never>;

let selectPatched = false;

/**
 * Build a Kysely instance whose builder chains are Effects. Accepts the
 * same `KyselyConfig` as `new Kysely(...)`. Kysely's promise API continues
 * to work; we only add `commit()` to builder prototypes.
 * @param config Documentation generation configuration.
 * @returns The created effect kysely.
 */
export function makeEffectKysely<DB>(config: KyselyConfig): EffectKysely<DB> {
  const db = new Kysely<DB>(config);
  if (!selectPatched) {
    // SelectQueryBuilder isn't exported from kysely; patch its prototype
    // from an instance produced by this specific Kysely.
    const selectProto = Reflect.getPrototypeOf(
      db.selectFrom(sql<{ readonly one: number }>`(select 1 as one)`.as("q")),
    );
    if (selectProto === null) {
      throw new KyselyPrototypeMissingError({
        message: "Kysely select builder must have a prototype.",
      });
    }
    patchPrototype(selectProto);
    selectPatched = true;
  }
  return db;
}

/**
 * Take the first row of an Effect that produces an array, as `Option`.
 * Effect equivalent of Kysely's `.executeTakeFirst()`.
 * @param query Value supplied to the operation.
 * @returns The take first option result.
 */
export const takeFirstOption = <A, E, R>(
  query: Effect.Effect<readonly A[], E, R>,
): Effect.Effect<Option.Option<A>, E, R> =>
  query.pipe(Effect.map((rows) => Option.fromNullable(rows[0])));

/**
 * Take the first row or fail with a caller-supplied error. Effect
 * equivalent of `.executeTakeFirst()` followed by a manual nullish check.
 * @param query Value supplied to the operation.
 * @param orElse Value supplied to the operation.
 * @returns The take first or else result.
 */
export const takeFirstOrElse = <A, E, R, E2>(
  query: Effect.Effect<readonly A[], E, R>,
  orElse: () => E2,
): Effect.Effect<A, E | E2, R> =>
  query.pipe(
    Effect.flatMap((rows) =>
      rows.length > 0
        ? Effect.succeed(
            /* Safe because the surrounding invariant establishes this asserted shape. */ rows[0] as A,
          )
        : Effect.fail(orElse()),
    ),
  );

/**
 * Take the first row or fail with a `NoSuchElementException`. Effect
 * equivalent of `.executeTakeFirstOrThrow()`.
 * @param query Value supplied to the operation.
 * @param message Value supplied to the operation.
 * @returns The take first or fail result.
 */
export const takeFirstOrFail = <A, E, R>(
  query: Effect.Effect<readonly A[], E, R>,
  message = "Expected at least one row",
): Effect.Effect<A, E | Cause.NoSuchElementException, R> =>
  query.pipe(
    Effect.flatMap((rows) =>
      rows.length > 0
        ? Effect.succeed(
            /* Safe because the surrounding invariant establishes this asserted shape. */ rows[0] as A,
          )
        : Effect.fail(new Cause.NoSuchElementException(message)),
    ),
  );

/**
 * Execute a Kysely raw `sql``...` builder and return the rows. Effect
 * equivalent of `sql``...`.execute(db)` + nullability/shape handling at
 * the call site.
 * @param db Value supplied to the operation.
 * @param query Value supplied to the operation.
 * @returns The raw query result.
 */
export const rawQuery = <A extends object, DB>(
  db: EffectKysely<DB> | Kysely<DB>,
  query: RawBuilder<A>,
): Effect.Effect<readonly A[], SqlError> =>
  Effect.tryPromise({
    try: () =>
      query.execute(
        /* Safe because the surrounding invariant establishes this asserted shape. */ db as Kysely<DB>,
      ),
    catch: (cause) =>
      cause instanceof SqlError
        ? cause
        : new SqlError({ cause, message: "raw query failed" }),
  }).pipe(Effect.map((result) => result.rows));

/**
 * Run `fn` inside a Kysely transaction. Kysely still owns the native
 * rollback Promise internally; callers keep their transactional body in
 * Effect so query builders can be yielded directly.
 * @param db Value supplied to the operation.
 * @param fn Value supplied to the operation.
 * @returns The transaction result.
 */
export const transaction = <A, DB>(
  db: EffectKysely<DB> | Kysely<DB>,
  fn: (
    trx: Transaction<DB>,
  ) => Effect.Effect<A, SqlError | Cause.NoSuchElementException>,
): Effect.Effect<A, SqlError> =>
  Effect.tryPromise({
    try: () =>
      (
        /* Safe because the surrounding invariant establishes this asserted shape. */
        db as Kysely<DB>
      )
        .transaction()
        .execute((trx) => Effect.runPromise(fn(trx))),
    catch: (cause) =>
      cause instanceof SqlError
        ? cause
        : new SqlError({ cause, message: "transaction failed" }),
  });

/**
 * Service boundary helper: swallow DB-plumbing errors (`SqlError`,
 * `NoSuchElementException`) into defects.
 *
 * DB-plumbing failures are infrastructure faults, not modeled outcomes,
 * so they surface at the wire edge as `InternalError`. Applying this at
 * service boundaries keeps public error channels as tagged-error
 * classes only.
 * @param effect Effect to execute.
 * @returns The catch sql error as defect result.
 */
export const catchSqlErrorAsDefect = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, SqlError | Cause.NoSuchElementException>, R> =>
  /* Safe because the surrounding invariant establishes this asserted shape. */ effect.pipe(
    Effect.catchAll((err) =>
      err instanceof SqlError || err instanceof Cause.NoSuchElementException
        ? Effect.die(err)
        : Effect.fail(err),
    ),
  ) as Effect.Effect<A, Exclude<E, SqlError | Cause.NoSuchElementException>, R>;

/**
 * Alias for callers that know their channel is just `SqlError`.
 * @param effect Effect to execute.
 * @returns The sql error to defect result.
 */
export const sqlErrorToDefect = <A, R>(
  effect: Effect.Effect<A, SqlError, R>,
): Effect.Effect<A, never, R> => catchSqlErrorAsDefect(effect);
