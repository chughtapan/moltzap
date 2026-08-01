// safer-arch-ignore no-cross-domain-sibling-import: Conversation mutations publish through the network notification port; direct leaf imports keep the runtime dependency graph acyclic.
// safer-arch-ignore folder-explicit-api-required: ConversationService is the deliberate concrete service boundary paired with the public conversation index.
import {
  type Db,
  sql,
  catchSqlErrorAsDefect,
  rawQuery,
  takeFirstOption,
  takeFirstOrFail,
  transaction,
} from "#db";
import {
  type Conversation,
  type ConversationId,
  ConversationFullError,
  ConversationNotFoundError,
  NotAParticipantError,
  conversationParticipantsRemovedNotificationDefinition,
} from "@moltzap/protocol/conversation";
import {
  type AgentId,
  type AppId,
  type UserId,
  AgentNotFoundError,
} from "@moltzap/protocol/identity";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect, Option } from "effect";
import {
  InvalidParamsError,
  DEFAULT_PAGE_LIMIT,
  ForbiddenError,
} from "@moltzap/protocol/rpc";
import { broadcastNotificationToAgents } from "../network/notification-broadcast.js";
import type { NetworkSendServiceTag } from "../network/layer.js";
import type { ConnectionManager } from "#socket";

const MAX_GROUP_PARTICIPANTS = 256;
const GROUP_OVERFLOW_MSG = `Group cannot exceed ${MAX_GROUP_PARTICIPANTS} participants`;
const MSG_CONVERSATION_NOT_FOUND = "Conversation not found";

interface ConversationColumns {
  readonly id: ConversationId;
  readonly name: string | null;
  readonly created_by_id: AgentId;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface CreateConversationOptions {
  readonly name?: string;
  readonly agentIds: readonly AgentId[];
  readonly creatorAgentId: AgentId;
  /** Authorizing app; the routing key every send and dispatch resolves. */
  readonly appId: AppId;
}

interface ListConversationsInput {
  readonly agentId: AgentId;
  readonly limit: number;
  readonly cursor?: string;
}

function mapConversation(row: ConversationColumns): Conversation {
  return {
    id: row.id,
    name: row.name ?? undefined,
    createdBy: row.created_by_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** A conversation and its membership, as the list surface returns them. */
interface ConversationListEntry {
  readonly conversation: Conversation;
  readonly participants: readonly AgentId[];
}

/** One page of the caller's conversations, most recently updated first. */
interface ConversationPage {
  readonly items: readonly ConversationListEntry[];
  readonly cursor?: string;
}

// Two queries regardless of page size: one for the page, one for the
// membership of every conversation on it.
function listConversations(
  db: Db,
  input: ListConversationsInput,
): Effect.Effect<ConversationPage, InvalidParamsError> {
  return catchSqlErrorAsDefect(
    Effect.gen(function* () {
      const cursorParam = yield* parseListCursor(input.cursor);
      const rows = yield* queryConversationListRows(db, {
        agentId: input.agentId,
        limit: input.limit,
        cursorParam,
      });
      const hasMore = rows.length > input.limit;
      const resultRows = hasMore ? rows.slice(0, input.limit) : rows;
      const participantsByConversation = yield* queryParticipantsFor(
        db,
        resultRows.map((row) => row.id),
      );
      return {
        items: resultRows.map((row) => ({
          conversation: mapConversation(row),
          participants: participantsByConversation.get(row.id) ?? [],
        })),
        cursor: nextConversationListCursor(hasMore, resultRows),
      };
    }),
  ).pipe(Effect.withSpan("listConversations"));
}

function queryParticipantsFor(
  db: Db,
  conversationIds: readonly ConversationId[],
): Effect.Effect<ReadonlyMap<ConversationId, AgentId[]>, SqlError> {
  if (conversationIds.length === 0) {
    return Effect.succeed(new Map());
  }
  return Effect.gen(function* () {
    const rows = yield* db
      .selectFrom("conversation_participants")
      .select(["conversation_id", "agent_id"])
      .where("conversation_id", "in", [...conversationIds]);
    const byConversation = new Map<ConversationId, AgentId[]>();
    for (const row of rows) {
      const agents = byConversation.get(row.conversation_id) ?? [];
      agents.push(row.agent_id);
      byConversation.set(row.conversation_id, agents);
    }
    return byConversation;
  });
}

// The cursor carries both halves of the sort key. Paging on a different
// expression than the one that orders the page lets a row move across the
// boundary between requests and vanish from every later page.
interface ListCursor {
  readonly updatedAt: string;
  readonly id: string;
}

const CURSOR_SEPARATOR = "|";

function isIsoTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return !Number.isNaN(parsed) && new Date(parsed).toISOString() === value;
}

function malformedCursor(): InvalidParamsError {
  return new InvalidParamsError({
    message:
      "Cursor must be an ISO-8601 timestamp and a conversation id joined by '|'",
  });
}

function parseListCursor(
  cursor?: string,
): Effect.Effect<ListCursor | null, InvalidParamsError> {
  if (cursor == null) {
    return Effect.succeed(null);
  }
  const [updatedAt, id, ...rest] = cursor.split(CURSOR_SEPARATOR);
  if (updatedAt === undefined || id === undefined || rest.length > 0) {
    return Effect.fail(malformedCursor());
  }
  if (!isIsoTimestamp(updatedAt)) {
    return Effect.fail(malformedCursor());
  }
  return Effect.succeed({ updatedAt, id });
}

interface ListRowsInput {
  readonly agentId: AgentId;
  readonly limit: number;
  readonly cursorParam: ListCursor | null;
}

// Sort key and cursor key are the same stored pair, so the page boundary lands
// exactly where the previous page stopped and `idx_conversations_listing`
// serves the ordering. `c.id` breaks ties between rows sharing a timestamp.
function queryConversationListRows(
  db: Db,
  input: ListRowsInput,
): Effect.Effect<readonly ConversationColumns[], SqlError> {
  return rawQuery(
    db,
    sql<ConversationColumns>`
      SELECT c.id, c.name, c.created_by_id, c.created_at, c.updated_at
      FROM conversation_participants cp
      JOIN conversations c ON c.id = cp.conversation_id
      WHERE cp.agent_id = ${input.agentId}
        ${cursorListFilter(input.cursorParam)}
      ORDER BY c.updated_at DESC, c.id DESC
      LIMIT ${input.limit + 1}
    `,
  );
}

function cursorListFilter(cursorParam: ListCursor | null) {
  if (cursorParam === null) {
    return sql``;
  }
  return sql`AND (c.updated_at, c.id)
      < (${cursorParam.updatedAt}::timestamptz, ${cursorParam.id}::uuid)`;
}

function nextConversationListCursor(
  hasMore: boolean,
  rows: readonly ConversationColumns[],
): string | undefined {
  const last = rows[rows.length - 1];
  if (!hasMore || last === undefined) {
    return undefined;
  }
  return `${last.updated_at.toISOString()}${CURSOR_SEPARATOR}${last.id}`;
}

/** Implements conversation service. */
export class ConversationService {
  private readonly db: Db;
  private readonly connections: ConnectionManager;

  constructor(db: Db, connections: ConnectionManager) {
    this.db = db;
    this.connections = connections;
  }

  create(input: CreateConversationOptions): Effect.Effect<Conversation> {
    return catchSqlErrorAsDefect(this.createConversationEffect(input));
  }

  private createConversationEffect(
    input: CreateConversationOptions,
  ): Effect.Effect<Conversation, SqlError> {
    return Effect.gen(
      function* (this: ConversationService) {
        const created = yield* this.insertConversation(input);
        yield* this.subscribeCreatedConversation(input, created.id);
        yield* this.logConversationCreated(input, created.id);
        return created;
      }.bind(this),
    );
  }

  /**
   * Loads the owner of every requested agent.
   * @param agentIds Value supplied to the operation.
   * @internal
   * @returns The rows result.
   */
  loadAgentOwners(
    agentIds: readonly AgentId[],
  ): Effect.Effect<
    ReadonlyMap<AgentId, UserId>,
    AgentNotFoundError | SqlError
  > {
    return Effect.gen(
      function* (this: ConversationService) {
        const rows =
          agentIds.length === 0
            ? []
            : yield* this.db
                .selectFrom("agents")
                .select(["id", "owner_user_id"])
                .where("id", "in", [...agentIds]);
        const ownerByAgentId = new Map<AgentId, UserId>();
        for (const row of rows) {
          ownerByAgentId.set(row.id, row.owner_user_id);
        }
        for (const agentId of agentIds) {
          if (!ownerByAgentId.has(agentId)) {
            return yield* new AgentNotFoundError({
              message: `Agent ${agentId} not found`,
            });
          }
        }
        return ownerByAgentId;
      }.bind(this),
    );
  }

  /**
   * Reduced-surface participant removal: NO authority gate. Used by
   * `AppEndpointRegistry.removeDeniedParticipant` for dispatch-deny eviction
   * (runs server-internally, not via a wire RPC). Broadcasts
   * `ConversationParticipantsRemoved` with `reason: "app_remove"`
   * so the evicted agent and the remaining participants observe the
   * removal.
   * @param conversationId Value supplied to the operation.
   * @param agentId Identifier of the agent targeted by the operation.
   * @internal
   * @returns The participants snapshot result.
   */
  removeParticipant(
    conversationId: ConversationId,
    agentId: AgentId,
  ): Effect.Effect<void, NotAParticipantError, NetworkSendServiceTag> {
    return catchSqlErrorAsDefect(
      Effect.gen(
        function* (this: ConversationService) {
          // Snapshot membership BEFORE delete so the evicted agent
          // is included in the fan-out target list.
          const participantsSnapshot =
            yield* this.getParticipantAgentIds(conversationId);
          const deleted = yield* this.db
            .deleteFrom("conversation_participants")
            .where("conversation_id", "=", conversationId)
            .where("agent_id", "=", agentId)
            .returning("conversation_id");
          if (deleted.length === 0) {
            return yield* new NotAParticipantError({
              message: "Participant not found",
            });
          }
          yield* this.connections.removeConversationFromAgent(
            agentId,
            conversationId,
          );
          yield* broadcastNotificationToAgents(
            participantsSnapshot,
            conversationParticipantsRemovedNotificationDefinition,
            {
              conversationId,
              removedAgentId: agentId,
              reason: "app_remove" as const,
            },
          );
        }.bind(this),
      ),
    );
  }

  /**
   * Rejects a membership that exceeds the group limit. Callers pass the
   * resulting member count, so creation and participant addition share one
   * capacity rule.
   * @param memberCount Value supplied to the operation.
   * @internal
   * @returns The capacity assertion result.
   */
  assertGroupCapacity(
    memberCount: number,
  ): Effect.Effect<void, ConversationFullError> {
    if (memberCount <= MAX_GROUP_PARTICIPANTS) {
      return Effect.void;
    }
    return Effect.fail(
      new ConversationFullError({ message: GROUP_OVERFLOW_MSG }),
    );
  }

  private insertConversation(
    input: CreateConversationOptions,
  ): Effect.Effect<Conversation, SqlError> {
    return transaction(this.db, (trx) =>
      Effect.gen(
        function* (this: ConversationService) {
          const conv = yield* takeFirstOrFail(
            trx
              .insertInto("conversations")
              .values({
                name: input.name ?? null,
                created_by_id: input.creatorAgentId,
                app_id: input.appId,
              })
              .returningAll(),
          );
          // The creator joins the conversation it opens; membership is the
          // creator plus every named participant.
          yield* trx.insertInto("conversation_participants").values({
            conversation_id: conv.id,
            agent_id: input.creatorAgentId,
          });
          for (const agentId of input.agentIds) {
            yield* trx
              .insertInto("conversation_participants")
              .values({ conversation_id: conv.id, agent_id: agentId })
              .onConflict((oc) => oc.doNothing());
          }
          return mapConversation(conv);
        }.bind(this),
      ),
    );
  }

  private subscribeCreatedConversation(
    input: CreateConversationOptions,
    conversationId: ConversationId,
  ): Effect.Effect<void> {
    // Mirrors `insertConversation`'s membership set.
    const memberAgentIds = [input.creatorAgentId, ...input.agentIds];
    return this.connections.addConversationToAgents(
      memberAgentIds,
      conversationId,
    );
  }

  private logConversationCreated(
    input: CreateConversationOptions,
    conversationId: ConversationId,
  ): Effect.Effect<void> {
    const participantCount = input.agentIds.length + 1;
    return Effect.logInfo("Conversation created").pipe(
      Effect.annotateLogs({
        conversationId,
        participantCount,
      }),
    );
  }

  list(
    agentId: AgentId,
    limit = DEFAULT_PAGE_LIMIT,
    cursor?: string,
  ): Effect.Effect<ConversationPage, InvalidParamsError> {
    return listConversations(this.db, { agentId, limit, cursor });
  }

  getParticipantAgentIds(
    conversationId: ConversationId,
  ): Effect.Effect<readonly AgentId[]> {
    return catchSqlErrorAsDefect(
      Effect.gen(
        function* (this: ConversationService) {
          const rows = yield* this.db
            .selectFrom("conversation_participants")
            .select("agent_id")
            .where("conversation_id", "=", conversationId);

          return rows.map((r) => r.agent_id);
        }.bind(this),
      ),
    );
  }

  /**
   * `app/conversation/update` add-participant body.
   *
   * Inserts a `conversation_participants` row (idempotent via
   * `ON CONFLICT DO NOTHING`) AND captures the post-mutation membership so
   * the handler can fan out the participants-added notification.
   * @param conversationId Value supplied to the operation.
   * @param agentId Identifier of the agent targeted by the operation.
   * @internal
   * @returns The post-mutation membership.
   */
  addConversationParticipant(
    conversationId: ConversationId,
    agentId: AgentId,
  ): Effect.Effect<{ postMutationParticipants: readonly AgentId[] }> {
    return catchSqlErrorAsDefect(
      Effect.gen(
        function* (this: ConversationService) {
          yield* this.db
            .insertInto("conversation_participants")
            .values({ conversation_id: conversationId, agent_id: agentId })
            .onConflict((oc) => oc.doNothing());
          const rows = yield* this.db
            .selectFrom("conversation_participants")
            .select("agent_id")
            .where("conversation_id", "=", conversationId);
          return { postMutationParticipants: rows.map((row) => row.agent_id) };
        }.bind(this),
      ),
    );
  }

  /**
   * `app/conversation/update` remove-participant body.
   *
   * Returns the pre-mutation membership snapshot so the handler can fan out
   * the participants-removed notification to the removed agent after their
   * `conversation_participants` row is deleted. Idempotent: no-op when the
   * agent is not currently in the conversation.
   * @param conversationId Value supplied to the operation.
   * @param agentId Identifier of the agent targeted by the operation.
   * @internal
   * @returns The pre-mutation membership and whether a row was deleted.
   */
  removeConversationParticipant(
    conversationId: ConversationId,
    agentId: AgentId,
  ): Effect.Effect<{
    preMutationParticipants: readonly AgentId[];
    wasParticipant: boolean;
  }> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* (this: ConversationService) {
        const preRows = yield* this.db
          .selectFrom("conversation_participants")
          .select("agent_id")
          .where("conversation_id", "=", conversationId);
        const preMutationParticipants: readonly AgentId[] = preRows.map(
          (row) => row.agent_id,
        );
        const wasParticipant = preMutationParticipants.includes(agentId);
        if (!wasParticipant) {
          return { preMutationParticipants, wasParticipant };
        }
        yield* this.db
          .deleteFrom("conversation_participants")
          .where("conversation_id", "=", conversationId)
          .where("agent_id", "=", agentId);
        return { preMutationParticipants, wasParticipant };
      }),
    );
  }

  /**
   * By-id projection used by list and mutation surfaces to surface the
   * `Conversation` row. Fails with `ConversationNotFoundError` when the
   * row is missing.
   * @param conversationId Value supplied to the operation.
   * @internal
   * @returns The row opt result.
   */
  loadById(
    conversationId: ConversationId,
  ): Effect.Effect<Conversation, ConversationNotFoundError> {
    return catchSqlErrorAsDefect(
      Effect.gen(
        function* (this: ConversationService) {
          const rowOpt = yield* takeFirstOption(
            this.db
              .selectFrom("conversations")
              .selectAll()
              .where("id", "=", conversationId),
          );
          if (Option.isNone(rowOpt)) {
            return yield* new ConversationNotFoundError({
              message: MSG_CONVERSATION_NOT_FOUND,
            });
          }
          return mapConversation(rowOpt.value);
        }.bind(this),
      ),
    );
  }

  /**
   * Authorizing app for a conversation. The routing key every app-authority
   * gate compares against.
   * @param conversationId Value supplied to the operation.
   * @internal
   * @returns The authorizing app id.
   */
  loadAppId(
    conversationId: ConversationId,
  ): Effect.Effect<AppId, ConversationNotFoundError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* (this: ConversationService) {
        const rowOpt = yield* takeFirstOption(
          this.db
            .selectFrom("conversations")
            .select("app_id")
            .where("id", "=", conversationId),
        );
        if (Option.isNone(rowOpt)) {
          return yield* Effect.fail(
            new ConversationNotFoundError({
              message: MSG_CONVERSATION_NOT_FOUND,
            }),
          );
        }
        return rowOpt.value.app_id;
      }),
    );
  }

  getConversationIds(agentId: AgentId): Effect.Effect<ConversationId[]> {
    return catchSqlErrorAsDefect(
      Effect.gen(
        function* (this: ConversationService) {
          const rows = yield* this.db
            .selectFrom("conversation_participants")
            .select("conversation_id")
            .where("agent_id", "=", agentId);
          return rows.map((r) => r.conversation_id);
        }.bind(this),
      ),
    );
  }

  assertConversationParticipant(
    conversationId: ConversationId,
    agentId: AgentId,
  ): Effect.Effect<void, ForbiddenError> {
    return catchSqlErrorAsDefect(
      Effect.gen(
        function* (this: ConversationService) {
          const rowOpt = yield* takeFirstOption(
            this.db
              .selectFrom("conversation_participants")
              .select(sql`1`.as("exists"))
              .where("conversation_id", "=", conversationId)
              .where("agent_id", "=", agentId),
          );

          if (Option.isNone(rowOpt)) {
            return yield* new ForbiddenError({
              message: "Not a participant in this conversation",
            });
          }
        }.bind(this),
      ),
    );
  }
}
