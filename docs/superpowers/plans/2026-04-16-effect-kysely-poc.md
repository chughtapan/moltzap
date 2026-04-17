# Effect Kysely POC

> **Purpose:** This is a copyable reference for the implementer. It captures the targeted `@effect/sql-kysely` proof-of-concept shape without forcing the main migration branch to adopt the runtime experiment directly.

**What this POC demonstrates:**
- builder chains can be used directly as `Effect`s
- `transaction().execute(...)` becomes `db.withTransaction(...)`
- `executeTakeFirst*` can be replaced with small toolkit helpers
- raw Kysely `sql`` ` can be compiled and executed via captured `SqlClient`

---

## `effect-kysely-toolkit.ts`

```ts
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
```

---

## `effect-kysely-conversation.ts`

```ts
import { SqlError } from "@effect/sql/SqlError";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { sql } from "kysely";
import type {
  ConversationType,
  Database,
  NewConversation,
  NewConversationParticipant,
} from "../src/db/database.js";
import type { EffectKyselyToolkit } from "./effect-kysely-toolkit.js";

interface ListRow {
  id: string;
  type: ConversationType;
  name: string | null;
  updated_at: Date;
  has_last_message: boolean;
  last_message_at: Date | null;
  unread_count: number;
}

interface CreateConversationInput {
  type: "dm" | "group";
  name?: string;
  agentIds: string[];
  creatorAgentId: string;
}

export function createConversationPoc(
  toolkit: EffectKyselyToolkit<Database>,
  input: CreateConversationInput,
): Effect.Effect<
  {
    conversationId: string;
    foundAgentCount: number;
  },
  SqlError
> {
  const db = toolkit.db;

  return db.withTransaction(
    Effect.gen(function* () {
      const foundAgents = yield* db
        .selectFrom("agents")
        .select("id")
        .where("id", "in", input.agentIds);

      const conversation: NewConversation = {
        type: input.type,
        name: input.name ?? null,
        created_by_id: input.creatorAgentId,
      };

      const created = yield* toolkit.takeFirstOrElse(
        db.insertInto("conversations").values(conversation).returningAll(),
        () => new SqlError({ message: "Expected inserted conversation row" }),
      );

      const ownerParticipant: NewConversationParticipant = {
        conversation_id: created.id,
        agent_id: input.creatorAgentId,
        role: "owner",
      };

      yield* db
        .insertInto("conversation_participants")
        .values(ownerParticipant);

      yield* Effect.forEach(
        input.agentIds,
        (agentId) => {
          const participant: NewConversationParticipant = {
            conversation_id: created.id,
            agent_id: agentId,
            role: "member",
          };

          return db
            .insertInto("conversation_participants")
            .values(participant)
            .onConflict((oc) => oc.doNothing());
        },
        { discard: true },
      );

      return {
        conversationId: created.id,
        foundAgentCount: foundAgents.length,
      };
    }),
  );
}

export function findConversationPoc(
  toolkit: EffectKyselyToolkit<Database>,
  conversationId: string,
): Effect.Effect<
  Option.Option<{
    id: string;
    type: ConversationType;
    name: string | null;
    created_by_id: string;
    created_at: Date;
    updated_at: Date;
  }>,
  SqlError
> {
  return toolkit.takeFirstOption(
    toolkit.db
      .selectFrom("conversations")
      .select([
        "id",
        "type",
        "name",
        "created_by_id",
        "created_at",
        "updated_at",
      ])
      .where("id", "=", conversationId),
  );
}

export function listConversationsPoc(
  toolkit: EffectKyselyToolkit<Database>,
  agentId: string,
  limit = 50,
  cursor?: string,
): Effect.Effect<
  {
    rows: ReadonlyArray<ListRow>;
    participantRows: Array<{
      conversation_id: string;
      agent_id: string;
    }>;
  },
  SqlError
> {
  const db = toolkit.db;

  return Effect.gen(function* () {
    const cursorParam = cursor ?? null;

    const rows = yield* toolkit.rawQuery(
      sql<ListRow>`
        SELECT c.id, c.type, c.name, c.updated_at,
               m.parts_encrypted IS NOT NULL as has_last_message,
               m.created_at as last_message_at,
               COALESCE(
                 (SELECT COUNT(*) FROM messages m2
                  WHERE m2.conversation_id = c.id
                  AND m2.seq > cp.last_read_seq
                  AND m2.is_deleted = false), 0
               )::int as unread_count
        FROM conversation_participants cp
        JOIN conversations c ON c.id = cp.conversation_id
        LEFT JOIN LATERAL (
          SELECT parts_encrypted, created_at, seq FROM messages
          WHERE conversation_id = c.id AND is_deleted = false
          ORDER BY seq DESC LIMIT 1
        ) m ON true
        WHERE cp.agent_id = ${agentId}
          AND c.archived_at IS NULL
          ${cursorParam ? sql`AND c.updated_at < ${cursorParam}` : sql``}
        ORDER BY COALESCE(m.created_at, c.updated_at) DESC
        LIMIT ${limit + 1}
      `,
    );

    const participantRows =
      rows.length === 0
        ? []
        : yield* db
            .selectFrom("conversation_participants")
            .select(["conversation_id", "agent_id"])
            .where(
              "conversation_id",
              "in",
              rows.map((row) => row.id),
            );

    return { rows, participantRows };
  });
}
```

---

## Reading Notes

- This is a migration aid, not the final architecture.
- The important part is the pattern:
  - capture `EffectKysely<DB>` and `SqlClient`
  - centralize first-row and raw-query handling
  - keep service code on a small Effect-native DB surface
- If the implementation proceeds with Plan C2, this toolkit shape should be introduced before broad service rewrites.
