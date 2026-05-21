/**
 * Sibling module to `conversation.service.ts` — Spec E (#601) Decision E.
 *
 * Hosts the list-conversation cursor-pagination cluster: cursor
 * validation, the conversation+last-message projection query, archive
 * filtering, summary mapping, and per-summary participant attachment.
 *
 * Pure-function exports (no service class state). The service class
 * keeps a thin `list(...)` delegate that wires `{ db, previewCache }`
 * into `listConversations`. Extraction reclaims ~150 effective lines
 * from `conversation.service.ts` so Phase 3 R-channel cutover edits
 * fit under the `max-lines: 1050` lint cap.
 */
import type { Db } from "../../../db/client.js";
import type {
  ConversationParticipant,
  ConversationSummary,
} from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId } from "@moltzap/protocol/task";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect } from "effect";
import { InvalidParamsError } from "@moltzap/protocol";
import { sql } from "../../../db/sql.js";
import {
  catchSqlErrorAsDefect,
  rawQuery,
} from "../../../db/effect-kysely-toolkit.js";
import type {
  ConversationArchiveFilter,
  ListRow,
} from "../conversation-service-types.js";

export interface ListConversationsDeps {
  readonly db: Db;
  readonly previewCache: ReadonlyMap<ConversationId, string>;
}

export interface ListConversationsInput {
  readonly agentId: AgentId;
  readonly limit: number;
  readonly cursor?: string;
  readonly archived: ConversationArchiveFilter;
}

export const listConversations = (
  deps: ListConversationsDeps,
  input: ListConversationsInput,
): Effect.Effect<
  { conversations: ConversationSummary[]; cursor?: string },
  InvalidParamsError
> => {
  const { db, previewCache } = deps;
  return catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const cursorParam = yield* parseListCursor(input.cursor);
      const rows = yield* queryConversationListRows(db, {
        agentId: input.agentId,
        limit: input.limit,
        cursorParam,
        archived: input.archived,
      });
      const hasMore = rows.length > input.limit;
      const resultRows = hasMore ? rows.slice(0, input.limit) : rows;
      const conversations = conversationSummariesFromRows(
        resultRows,
        previewCache,
      );
      yield* attachSummaryParticipants(db, conversations);
      return {
        conversations,
        cursor: nextConversationListCursor(hasMore, resultRows),
      };
    }),
  ).pipe(Effect.withSpan("listConversations"));
};

const parseListCursor = (
  cursor: string | undefined,
): Effect.Effect<string | null, InvalidParamsError> => {
  if (cursor == null) return Effect.succeed(null);
  const parsed = new Date(cursor);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== cursor) {
    return Effect.fail(
      new InvalidParamsError({
        message: "Cursor must be an ISO-8601 timestamp",
      }),
    );
  }
  return Effect.succeed(cursor);
};

interface ListRowsInput {
  readonly agentId: AgentId;
  readonly limit: number;
  readonly cursorParam: string | null;
  readonly archived: ConversationArchiveFilter;
}

const queryConversationListRows = (
  db: Db,
  input: ListRowsInput,
): Effect.Effect<ReadonlyArray<ListRow>, SqlError> =>
  rawQuery(
    db,
    sql<ListRow>`
      SELECT c.id, c.name, c.updated_at,
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
      WHERE cp.agent_id = ${input.agentId}
        ${archivedListFilter(input.archived)}
        ${cursorListFilter(input.cursorParam)}
      ORDER BY COALESCE(m.created_at, c.updated_at) DESC
      LIMIT ${input.limit + 1}
    `,
  );

const archivedListFilter = (archived: ConversationArchiveFilter) => {
  switch (archived) {
    case "only":
      return sql`AND c.archived_at IS NOT NULL`;
    case "include":
      return sql``;
    case "exclude":
      return sql`AND c.archived_at IS NULL`;
  }
};

const cursorListFilter = (cursorParam: string | null) => {
  if (cursorParam === null) return sql``;
  return sql`AND c.updated_at < ${cursorParam}`;
};

const conversationSummariesFromRows = (
  rows: ReadonlyArray<ListRow>,
  previewCache: ReadonlyMap<ConversationId, string>,
): ConversationSummary[] =>
  rows.map((row) => ({
    id: row.id,
    name: row.name ?? undefined,
    lastMessagePreview: previewCache.get(row.id),
    lastMessageTimestamp: row.last_message_at?.toISOString(),
    unreadCount: row.unread_count,
  }));

const attachSummaryParticipants = (
  db: Db,
  conversations: ConversationSummary[],
): Effect.Effect<void, SqlError> => {
  if (conversations.length === 0) return Effect.void;
  return Effect.gen(function* () {
    const convIds = conversations.map((conversation) => conversation.id);
    const rows = yield* db
      .selectFrom("conversation_participants")
      .select(["conversation_id", "agent_id"])
      .where("conversation_id", "in", convIds);
    const partsByConv = participantRefsByConversation(rows);
    for (const conversation of conversations) {
      conversation.participants = partsByConv.get(conversation.id) ?? [];
    }
  });
};

type ParticipantRef = ConversationParticipant["participant"];

const participantRefsByConversation = (
  rows: ReadonlyArray<{ conversation_id: ConversationId; agent_id: AgentId }>,
): Map<ConversationId, Array<ParticipantRef>> => {
  const partsByConv = new Map<ConversationId, Array<ParticipantRef>>();
  for (const row of rows) {
    const participants = partsByConv.get(row.conversation_id) ?? [];
    participants.push({ type: "agent", id: row.agent_id });
    partsByConv.set(row.conversation_id, participants);
  }
  return partsByConv;
};

const nextConversationListCursor = (
  hasMore: boolean,
  rows: ReadonlyArray<ListRow>,
): string | undefined => {
  if (!hasMore) return undefined;
  return rows[rows.length - 1]?.updated_at.toISOString();
};
