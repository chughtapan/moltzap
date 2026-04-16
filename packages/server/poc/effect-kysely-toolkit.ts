import type { SqlClient as EffectSqlClient } from "@effect/sql/SqlClient";
import * as PgKysely from "@effect/sql-kysely/Pg";
import type { EffectKysely } from "@effect/sql-kysely/Pg";
import * as SqlClient from "@effect/sql/SqlClient";
import { SqlError } from "@effect/sql/SqlError";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { RawBuilder } from "kysely";

export interface EffectKyselyToolkit<DB> {
  readonly db: EffectKysely<DB>;
  readonly takeFirstOption: <A, E, R>(
    query: Effect.Effect<ReadonlyArray<A>, E, R>,
  ) => Effect.Effect<Option.Option<A>, E, R>;
  readonly takeFirstOrElse: <A, E, R, E2>(
    query: Effect.Effect<ReadonlyArray<A>, E, R>,
    orElse: () => E2,
  ) => Effect.Effect<A, E | E2, R>;
  readonly takeFirstOrFail: <A, E, R>(
    query: Effect.Effect<ReadonlyArray<A>, E, R>,
    message?: string,
  ) => Effect.Effect<A, E | Cause.NoSuchElementException, R>;
  readonly rawQuery: <A extends object>(
    query: RawBuilder<A>,
  ) => Effect.Effect<ReadonlyArray<A>, SqlError>;
}

/**
 * Capture both the patched Kysely instance and the underlying SqlClient.
 *
 * This closes the gap left by `@effect/sql-kysely`:
 * - `takeFirstOption` / `takeFirstOrFail` replace `executeTakeFirst*`
 * - `rawQuery` executes compiled raw Kysely SQL via `SqlClient.unsafe`
 */
export function makeEffectKyselyToolkit<DB>(
  db: EffectKysely<DB>,
  client: EffectSqlClient,
): EffectKyselyToolkit<DB> {
  return {
    db,
    takeFirstOption: <A, E, R>(
      query: Effect.Effect<ReadonlyArray<A>, E, R>,
    ): Effect.Effect<Option.Option<A>, E, R> =>
      query.pipe(Effect.map((rows) => Option.fromNullable(rows[0]))),
    takeFirstOrElse: <A, E, R, E2>(
      query: Effect.Effect<ReadonlyArray<A>, E, R>,
      orElse: () => E2,
    ): Effect.Effect<A, E | E2, R> =>
      query.pipe(
        Effect.flatMap((rows) =>
          rows.length > 0 ? Effect.succeed(rows[0] as A) : Effect.fail(orElse()),
        ),
      ),
    takeFirstOrFail: <A, E, R>(
      query: Effect.Effect<ReadonlyArray<A>, E, R>,
      message = "Expected at least one row",
    ): Effect.Effect<A, E | Cause.NoSuchElementException, R> =>
      query.pipe(
        Effect.flatMap((rows) =>
          rows.length > 0
            ? Effect.succeed(rows[0] as A)
            : Effect.fail(new Cause.NoSuchElementException(message)),
        ),
      ),
    rawQuery: <A extends object>(
      query: RawBuilder<A>,
    ): Effect.Effect<ReadonlyArray<A>, SqlError> => {
      const compiled = query.compile(db);
      return client.unsafe<A>(compiled.sql, compiled.parameters);
    },
  };
}

export function makePgEffectKyselyToolkit<DB>(): Effect.Effect<
  EffectKyselyToolkit<DB>,
  never,
  SqlClient.SqlClient
> {
  return Effect.gen(function* () {
    const client = yield* SqlClient.SqlClient;
    const db = yield* PgKysely.make<DB>();
    return makeEffectKyselyToolkit(db, client);
  });
}
