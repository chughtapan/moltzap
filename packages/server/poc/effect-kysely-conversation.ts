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

/**
 * Targeted POC against the current conversation-service query shapes.
 *
 * This version uses a small local toolkit to make the remaining rough edges
 * feel native:
 * - `takeFirstOption` / `takeFirstOrFail` replace `executeTakeFirst*`
 * - `rawQuery` executes Kysely raw SQL through captured `SqlClient`
 * - transactions still move to `db.withTransaction(effect)`
 */
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
