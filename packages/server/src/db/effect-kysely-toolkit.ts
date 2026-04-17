/**
 * Makes Kysely builders usable as Effects: `yield* qb` instead of
 * `yield* Effect.tryPromise(() => qb.execute())`. Patches the builder
 * prototypes to be Effectable. `@effect/sql-kysely`'s Proxy variant
 * infinite-recurses on `bytea` columns, so we skip it.
 */
import { SqlError } from "@effect/sql/SqlError";
import { Cause, Effect, Effectable, Option } from "effect";
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
  UpdateQueryBuilder,
  WheneableMergeQueryBuilder,
  type KyselyConfig,
  type RawBuilder,
  type Transaction,
} from "kysely";

// Pulls in `declare module "kysely"` augmentations so `yield* qb` type-checks.
// TYPE-ONLY import: the runtime module installs a Proxy wrapper that re-wraps
// every returned row value, which causes `Buffer.from(proxy)` on bytea columns
// to infinite-recurse through the get trap. We only want the type augmentations;
// our own prototype patching below provides the runtime bridge.
import type {} from "@effect/sql-kysely/Pg";

const ATTR_DB_QUERY_TEXT = "db.query.text";

/**
 * Builder-as-Effect: when a builder instance is yielded, Effect runtime
 * calls `.commit()` on it. We implement `commit` as a thin wrapper over
 * Kysely's native `.execute()` — that's the only bridge needed.
 *
 * `this` at call time is the real builder instance, so `this.execute()`
 * and `this.compile()` hit Kysely directly with no indirection.
 */
function commitViaExecute(this: {
  execute: () => Promise<ReadonlyArray<unknown>>;
  compile: () => { sql: string };
}): Effect.Effect<ReadonlyArray<unknown>, SqlError> {
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
 */
function patchPrototype(prototype: object): void {
  Object.assign(prototype, Effectable.CommitPrototype);
  (prototype as { commit: unknown }).commit = commitViaExecute;
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
 * `EffectKysely<DB>` — a Kysely instance whose builders are also Effects.
 *
 * Structurally identical to `Kysely<DB>`; the Effect-capability is added
 * on the builder prototypes. Kept as a separate type alias so call sites
 * that want to be explicit about the capability can signal it.
 */
export type EffectKysely<DB> = Kysely<DB>;

let selectPatched = false;

/**
 * Build a Kysely instance whose builder chains are Effects. Accepts the
 * same `KyselyConfig` as `new Kysely(...)`. Kysely's promise API continues
 * to work; we only add `commit()` to builder prototypes.
 */
export function makeEffectKysely<DB>(config: KyselyConfig): EffectKysely<DB> {
  const db = new Kysely<DB>(config);
  if (!selectPatched) {
    // SelectQueryBuilder isn't exported from kysely; patch its prototype
    // from an instance produced by this specific Kysely.
    const selectProto = Object.getPrototypeOf(db.selectFrom("" as never));
    patchPrototype(selectProto);
    selectPatched = true;
  }
  return db;
}

/**
 * Take the first row of an Effect that produces an array, as `Option`.
 * Replaces `.executeTakeFirst()`.
 */
export const takeFirstOption = <A, E, R>(
  query: Effect.Effect<ReadonlyArray<A>, E, R>,
): Effect.Effect<Option.Option<A>, E, R> =>
  query.pipe(Effect.map((rows) => Option.fromNullable(rows[0])));

/**
 * Take the first row or fail with a caller-supplied error. Replaces
 * `.executeTakeFirst()` followed by a manual nullish check.
 */
export const takeFirstOrElse = <A, E, R, E2>(
  query: Effect.Effect<ReadonlyArray<A>, E, R>,
  orElse: () => E2,
): Effect.Effect<A, E | E2, R> =>
  query.pipe(
    Effect.flatMap((rows) =>
      rows.length > 0 ? Effect.succeed(rows[0] as A) : Effect.fail(orElse()),
    ),
  );

/**
 * Take the first row or fail with a `NoSuchElementException`. Replaces
 * `.executeTakeFirstOrThrow()`.
 */
export const takeFirstOrFail = <A, E, R>(
  query: Effect.Effect<ReadonlyArray<A>, E, R>,
  message = "Expected at least one row",
): Effect.Effect<A, E | Cause.NoSuchElementException, R> =>
  query.pipe(
    Effect.flatMap((rows) =>
      rows.length > 0
        ? Effect.succeed(rows[0] as A)
        : Effect.fail(new Cause.NoSuchElementException(message)),
    ),
  );

/**
 * Execute a Kysely raw `sql``...` builder and return the rows. Replaces
 * `sql``...`.execute(db)` + nullability/shape handling at the call site.
 */
export const rawQuery = <A extends object, DB>(
  db: EffectKysely<DB> | Kysely<DB>,
  query: RawBuilder<A>,
): Effect.Effect<ReadonlyArray<A>, SqlError> =>
  Effect.tryPromise({
    // #ignore-sloppy-code-next-line[async-keyword]: Effect.tryPromise try closure wrapping Kysely .execute()
    try: async () => {
      const result = await query.execute(db as Kysely<DB>);
      return result.rows as unknown as ReadonlyArray<A>;
    },
    catch: (cause) =>
      cause instanceof SqlError
        ? cause
        : new SqlError({ cause, message: "raw query failed" }),
  });

/**
 * Run `fn` inside a Kysely transaction. The callback receives a
 * `Transaction<DB>` and returns a `Promise<A>` — Kysely's native
 * transaction primitive, just lifted into `Effect`.
 */
export const transaction = <A, DB>(
  db: EffectKysely<DB> | Kysely<DB>,
  fn: (trx: Transaction<DB>) => Promise<A>,
): Effect.Effect<A, SqlError> =>
  Effect.tryPromise({
    try: () => (db as Kysely<DB>).transaction().execute((trx) => fn(trx)),
    catch: (cause) =>
      cause instanceof SqlError
        ? cause
        : new SqlError({ cause, message: "transaction failed" }),
  });

/**
 * Service boundary helper: swallow DB-plumbing errors (`SqlError`,
 * `NoSuchElementException`) into defects.
 *
 * Kysely used to throw on driver errors, and call sites that called
 * `.executeTakeFirstOrThrow()` let a throw bubble up. Both paths were
 * treated as defects at the wire edge (→ `InternalError`). The Effect
 * bridge surfaces them as typed errors in the error channel. Applying
 * this at service boundaries preserves the existing semantics while
 * keeping public error channels as `RpcFailure` only.
 */
export const catchSqlErrorAsDefect = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, Exclude<E, SqlError | Cause.NoSuchElementException>, R> =>
  effect.pipe(
    Effect.catchAll((err) =>
      err instanceof SqlError || err instanceof Cause.NoSuchElementException
        ? Effect.die(err)
        : Effect.fail(err),
    ),
  ) as Effect.Effect<A, Exclude<E, SqlError | Cause.NoSuchElementException>, R>;

/** Alias for callers that know their channel is just `SqlError`. */
export const sqlErrorToDefect = <A, R>(
  effect: Effect.Effect<A, SqlError, R>,
): Effect.Effect<A, never, R> =>
  catchSqlErrorAsDefect(effect) as Effect.Effect<A, never, R>;
