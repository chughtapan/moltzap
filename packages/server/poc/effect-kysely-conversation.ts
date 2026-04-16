import { SqlError } from "@effect/sql/SqlError";
import type { EffectKysely } from "@effect/sql-kysely/Pg";
import * as Effect from "effect/Effect";
import { sql } from "kysely";
import type {
  ConversationType,
  Database,
  NewConversation,
  NewConversationParticipant,
} from "../src/db/database.js";

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

function sqlError(message: string, cause: unknown): SqlError {
  return new SqlError({ cause, message });
}

function fromPromiseQuery<A>(
  message: string,
  thunk: () => Promise<A>,
): Effect.Effect<A, SqlError> {
  return Effect.tryPromise({
    try: thunk,
    catch: (cause) => sqlError(message, cause),
  });
}

/**
 * Targeted POC against the current conversation-service query shapes.
 *
 * What works cleanly with `@effect/sql-kysely`:
 * - builder chains can be `yield*`'d directly
 * - insert / update builders become `Effect`s
 * - transactions move to `db.withTransaction(effect)`
 *
 * What still needs a bridge:
 * - `.executeTakeFirst()` / `.executeTakeFirstOrThrow()`
 * - raw `sql``.execute(db)` fragments
 */
export function createConversationPoc(
  db: EffectKysely<Database>,
  input: CreateConversationInput,
): Effect.Effect<
  {
    conversationId: string;
    foundAgentCount: number;
  },
  SqlError
> {
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

      // `executeTakeFirstOrThrow()` remains Promise-based even on the patched builders.
      const created = yield* fromPromiseQuery(
        "effect-kysely POC: insert conversation",
        () =>
          db
            .insertInto("conversations")
            .values(conversation)
            .returningAll()
            .executeTakeFirstOrThrow(),
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

export function listConversationsPoc(
  db: EffectKysely<Database>,
  agentId: string,
  limit = 50,
  cursor?: string,
): Effect.Effect<
  {
    rows: ListRow[];
    participantRows: Array<{
      conversation_id: string;
      agent_id: string;
    }>;
  },
  SqlError
> {
  return Effect.gen(function* () {
    const cursorParam = cursor ?? null;

    // Raw SQL fragments still use Kysely's Promise-returning `.execute(db)` API.
    const rows = yield* fromPromiseQuery(
      "effect-kysely POC: raw conversation list",
      async () => {
        const result = await sql<ListRow>`
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
        `.execute(db);

        return result.rows;
      },
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
