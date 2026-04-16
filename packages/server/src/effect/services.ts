import { Context, Effect } from "effect";
import type { Kysely } from "kysely";
import type { Database } from "../db/database.js";
import type { Logger } from "../logger.js";

export class Db extends Context.Tag("Db")<Db, Kysely<Database>>() {}

export class Log extends Context.Tag("Log")<Log, Logger>() {}

export const tryDb = <A>(
  f: (db: Kysely<Database>) => Promise<A>,
): Effect.Effect<A, Error, Db> =>
  Effect.flatMap(Db, (db) =>
    Effect.tryPromise({
      try: () => f(db),
      catch: (err) => (err instanceof Error ? err : new Error(String(err))),
    }),
  );
