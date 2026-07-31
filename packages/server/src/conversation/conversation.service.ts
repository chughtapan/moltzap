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
  type ConversationParticipant,
  type ConversationId,
  ConversationFullError,
  ConversationNotFoundError,
  NotAParticipantError,
  conversationParticipantsRemovedNotificationDefinition,
} from "@moltzap/protocol/conversation";
import {
  type AgentId,
  type UserId,
  AgentNotFoundError,
  NotInContactsError,
} from "@moltzap/protocol/identity";
import type { AppId, TaskId } from "@moltzap/protocol/task";
import { BoundedMap } from "@moltzap/protocol/bounded-map";
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
const PREVIEW_CACHE_MAX = 2000;
const PREVIEW_CACHE_TEXT_CHARS = 80;
const MSG_CONVERSATION_NOT_FOUND = "Conversation not found";

type ContactPolicyCheck = (
  ownerUserIdA: UserId,
  ownerUserIdB: UserId,
) => Effect.Effect<boolean>;

type ContactPolicyResolver = () => ContactPolicyCheck | null;
const NO_CONTACT_POLICY_RESOLVER: ContactPolicyResolver = () => null;

interface ConversationColumns {
  readonly id: ConversationId;
  readonly name: string | null;
  readonly created_by_id: AgentId;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/** Conversation projection returned by the list surface. */
interface ConversationSummary {
  readonly id: ConversationId;
  readonly name?: string;
  readonly lastMessagePreview?: string;
  readonly lastMessageTimestamp?: string;
  readonly participants?: ReadonlyArray<ConversationParticipant["participant"]>;
}

interface CreateConversationOptions<TaskMintError = never> {
  readonly name?: string;
  readonly agentIds: readonly AgentId[];
  readonly creatorAgentId: AgentId;
  /** Authorizing app; the routing key every send and dispatch resolves. */
  readonly appId: AppId;
  readonly seedCreatorAsParticipant?: boolean;
  readonly mintTask: Effect.Effect<{ id: TaskId }, TaskMintError>;
}

interface CreatorContactPolicyInput {
  readonly creatorAgentId: AgentId;
  readonly targetAgentIds: readonly AgentId[];
  readonly ownerByAgentId: ReadonlyMap<AgentId, UserId>;
  readonly policy: ContactPolicyCheck;
}

interface ContactEdgeInput {
  readonly requesterAgentId: AgentId;
  readonly requesterOwnerUserId: UserId;
  readonly targetAgentId: AgentId;
  readonly targetOwnerUserId: UserId;
  readonly policy: ContactPolicyCheck;
}

interface ListConversationsDeps {
  readonly db: Db;
  readonly previewCache: ReadonlyMap<ConversationId, string>;
}

interface ListConversationsInput {
  readonly agentId: AgentId;
  readonly limit: number;
  readonly cursor?: string;
}

function listConversations(
  deps: ListConversationsDeps,
  input: ListConversationsInput,
): Effect.Effect<
  { conversations: ConversationSummary[]; cursor?: string },
  InvalidParamsError
> {
  const { db, previewCache } = deps;
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
}

function parseListCursor(
  cursor?: string,
): Effect.Effect<string | null, InvalidParamsError> {
  if (cursor == null) {
    return Effect.succeed(null);
  }
  const parsed = new Date(cursor);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== cursor) {
    return Effect.fail(
      new InvalidParamsError({
        message: "Cursor must be an ISO-8601 timestamp",
      }),
    );
  }
  return Effect.succeed(cursor);
}

interface ListRowsInput {
  readonly agentId: AgentId;
  readonly limit: number;
  readonly cursorParam: string | null;
}

interface ConversationListRow {
  readonly id: ConversationId;
  readonly name: string | null;
  readonly updated_at: Date;
  readonly has_last_message: boolean;
  readonly last_message_at: Date | null;
}

function queryConversationListRows(
  db: Db,
  input: ListRowsInput,
): Effect.Effect<readonly ConversationListRow[], SqlError> {
  return rawQuery(
    db,
    sql<ConversationListRow>`
      SELECT c.id, c.name, c.updated_at,
             m.parts_encrypted IS NOT NULL as has_last_message,
             m.created_at as last_message_at
      FROM conversation_participants cp
      JOIN conversations c ON c.id = cp.conversation_id
      LEFT JOIN LATERAL (
        SELECT parts_encrypted, created_at, seq FROM messages
        WHERE conversation_id = c.id AND is_deleted = false
        ORDER BY seq DESC LIMIT 1
      ) m ON true
      WHERE cp.agent_id = ${input.agentId}
        ${cursorListFilter(input.cursorParam)}
      ORDER BY COALESCE(m.created_at, c.updated_at) DESC
      LIMIT ${input.limit + 1}
    `,
  );
}

function cursorListFilter(cursorParam: string | null) {
  if (cursorParam === null) {
    return sql``;
  }
  return sql`AND c.updated_at < ${cursorParam}`;
}

type MutableConversationSummary = Omit<ConversationSummary, "participants"> & {
  participants?: ReadonlyArray<ConversationParticipant["participant"]>;
};

function conversationSummariesFromRows(
  rows: readonly ConversationListRow[],
  previewCache: ReadonlyMap<ConversationId, string>,
): MutableConversationSummary[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.name ?? undefined,
    lastMessagePreview: previewCache.get(row.id),
    lastMessageTimestamp: row.last_message_at?.toISOString(),
  }));
}

function attachSummaryParticipants(
  db: Db,
  conversations: MutableConversationSummary[],
): Effect.Effect<void, SqlError> {
  if (conversations.length === 0) {
    return Effect.void;
  }
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
}

type ParticipantRef = ConversationParticipant["participant"];

function participantRefsByConversation(
  rows: ReadonlyArray<{ conversation_id: ConversationId; agent_id: AgentId }>,
): Map<ConversationId, ParticipantRef[]> {
  const partsByConv = new Map<ConversationId, ParticipantRef[]>();
  for (const row of rows) {
    const participants = partsByConv.get(row.conversation_id) ?? [];
    participants.push({ type: "agent", id: row.agent_id });
    partsByConv.set(row.conversation_id, participants);
  }
  return partsByConv;
}

function nextConversationListCursor(
  hasMore: boolean,
  rows: readonly ConversationListRow[],
): string | undefined {
  if (!hasMore) {
    return undefined;
  }
  return rows[rows.length - 1]?.updated_at.toISOString();
}

/** Implements conversation service. */
export class ConversationService {
  /** In-memory cache for last-message previews, avoiding repeated decryption. */
  private readonly previewCache = new BoundedMap<ConversationId, string>(
    PREVIEW_CACHE_MAX,
  );

  private readonly db: Db;
  private readonly connections: ConnectionManager;
  private readonly resolveContactPolicy: ContactPolicyResolver;

  constructor(
    db: Db,
    connections: ConnectionManager,
    resolveContactPolicy?: ContactPolicyResolver,
  ) {
    this.db = db;
    this.connections = connections;
    this.resolveContactPolicy =
      resolveContactPolicy ?? NO_CONTACT_POLICY_RESOLVER;
  }

  /**
   * Writes the plaintext preview before message-part encryption.
   * @param conversationId Value supplied to the operation.
   * @param firstPartText Value supplied to the operation.
   */
  updatePreviewCache(
    conversationId: ConversationId,
    firstPartText: string,
  ): void {
    this.previewCache.set(
      conversationId,
      firstPartText.slice(0, PREVIEW_CACHE_TEXT_CHARS),
    );
  }

  create<TaskMintError = never>(
    input: CreateConversationOptions<TaskMintError>,
  ): Effect.Effect<Conversation, TaskMintError> {
    return catchSqlErrorAsDefect(this.createConversationEffect(input));
  }

  private createConversationEffect<TaskMintError>(
    input: CreateConversationOptions<TaskMintError>,
  ): Effect.Effect<Conversation, TaskMintError | SqlError> {
    return Effect.gen(this, function* (this: ConversationService) {
      const task = yield* input.mintTask;
      const created = yield* this.insertConversation(input, task.id);
      yield* this.subscribeCreatedConversation(input, created.id);
      yield* this.logConversationCreated(input, created.id);
      return created;
    });
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
    return Effect.gen(this, function* (this: ConversationService) {
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
          return yield* Effect.fail(
            new AgentNotFoundError({ message: `Agent ${agentId} not found` }),
          );
        }
      }
      return ownerByAgentId;
    });
  }

  /**
   * Enforces creator-to-target contact policy for a new conversation.
   * @param creatorAgentId Value supplied to the operation.
   * @param targetAgentIds Value supplied to the operation.
   * @param ownerByAgentId Value supplied to the operation.
   * @internal
   * @returns The policy result.
   */
  assertContactPolicyForCreate(
    creatorAgentId: AgentId,
    targetAgentIds: readonly AgentId[],
    ownerByAgentId: ReadonlyMap<AgentId, UserId>,
  ): Effect.Effect<void, AgentNotFoundError | NotInContactsError> {
    const policy = this.resolveContactPolicy();
    if (policy === null || targetAgentIds.length === 0) {
      return Effect.void;
    }
    return this.assertCreatorContactsAll({
      creatorAgentId,
      targetAgentIds,
      ownerByAgentId,
      policy,
    });
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
      Effect.gen(this, function* (this: ConversationService) {
        // Snapshot membership BEFORE delete so the evicted agent
        // is included in the fan-out target list.
        const participantsSnapshot =
          yield* this.getParticipantAgentIds(conversationId);
        const taskRowOpt = yield* takeFirstOption(
          this.db
            .selectFrom("conversations")
            .select("task_id")
            .where("id", "=", conversationId),
        );
        const taskId = Option.match(taskRowOpt, {
          onNone: () => null,
          onSome: (row) => row.task_id,
        });
        const deleted = yield* this.db
          .deleteFrom("conversation_participants")
          .where("conversation_id", "=", conversationId)
          .where("agent_id", "=", agentId)
          .returning("conversation_id");
        if (deleted.length === 0) {
          return yield* Effect.fail(
            new NotAParticipantError({ message: "Participant not found" }),
          );
        }
        yield* this.connections.removeConversationFromAgent(
          agentId,
          conversationId,
        );
        if (taskId !== null) {
          yield* broadcastNotificationToAgents(
            participantsSnapshot,
            conversationParticipantsRemovedNotificationDefinition,
            {
              taskId,
              conversationId,
              removedAgentId: agentId,
              reason: "app_remove" as const,
            },
          );
        }
      }),
    );
  }

  /**
   * Rejects a conversation whose initial group exceeds capacity.
   * @param targetAgentIds Value supplied to the operation.
   * @internal
   * @returns The conv result.
   */
  assertGroupCapacityForCreate(
    targetAgentIds: readonly AgentId[],
  ): Effect.Effect<void, ConversationFullError> {
    if (targetAgentIds.length + 1 <= MAX_GROUP_PARTICIPANTS) {
      return Effect.void;
    }
    return Effect.fail(
      new ConversationFullError({ message: GROUP_OVERFLOW_MSG }),
    );
  }

  private insertConversation<TaskMintError>(
    input: CreateConversationOptions<TaskMintError>,
    taskId: TaskId,
  ): Effect.Effect<Conversation, SqlError> {
    return transaction(this.db, (trx) =>
      Effect.gen(this, function* (this: ConversationService) {
        const conv = yield* takeFirstOrFail(
          trx
            .insertInto("conversations")
            .values({
              name: input.name ?? null,
              created_by_id: input.creatorAgentId,
              task_id: taskId,
              app_id: input.appId,
            })
            .returningAll(),
        );
        // The creator is auto-seeded as a participant only on the agent
        // path. The app-originated `app/conversation/create` passes
        // `seedCreatorAsParticipant: false`: membership = exactly
        // `input.agentIds`.
        if (input.seedCreatorAsParticipant !== false) {
          yield* trx.insertInto("conversation_participants").values({
            conversation_id: conv.id,
            agent_id: input.creatorAgentId,
          });
        }
        for (const agentId of input.agentIds) {
          yield* trx
            .insertInto("conversation_participants")
            .values({ conversation_id: conv.id, agent_id: agentId })
            .onConflict((oc) => oc.doNothing());
        }
        return this.mapConversation(conv);
      }),
    );
  }

  private subscribeCreatedConversation<TaskMintError>(
    input: CreateConversationOptions<TaskMintError>,
    conversationId: ConversationId,
  ): Effect.Effect<void> {
    // Mirrors `insertConversation`'s membership set: the creator is
    // subscribed only when it was seeded as a participant.
    const memberAgentIds =
      input.seedCreatorAsParticipant !== false
        ? [input.creatorAgentId, ...input.agentIds]
        : [...input.agentIds];
    return this.connections.addConversationToAgents(
      memberAgentIds,
      conversationId,
    );
  }

  private logConversationCreated<TaskMintError>(
    input: CreateConversationOptions<TaskMintError>,
    conversationId: ConversationId,
  ): Effect.Effect<void> {
    const participantCount =
      input.seedCreatorAsParticipant !== false
        ? input.agentIds.length + 1
        : input.agentIds.length;
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
  ): Effect.Effect<
    { conversations: ConversationSummary[]; cursor?: string },
    InvalidParamsError
  > {
    return listConversations(
      { db: this.db, previewCache: this.previewCache },
      { agentId, limit, cursor },
    );
  }

  getParticipantAgentIds(
    conversationId: ConversationId,
  ): Effect.Effect<readonly AgentId[]> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* (this: ConversationService) {
        const rows = yield* this.db
          .selectFrom("conversation_participants")
          .select("agent_id")
          .where("conversation_id", "=", conversationId);

        return rows.map((r) => r.agent_id);
      }),
    );
  }

  /**
   * Parent task lookup for `agent/conversation/list` row projection.
   * `conversations.task_id` is NOT NULL, so the only failure mode is
   * `ConversationNotFoundError` (row missing).
   * @param conversationId Value supplied to the operation.
   * @internal
   * @returns The row opt result.
   */
  taskIdForConversation(
    conversationId: ConversationId,
  ): Effect.Effect<TaskId, ConversationNotFoundError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* (this: ConversationService) {
        const rowOpt = yield* takeFirstOption(
          this.db
            .selectFrom("conversations")
            .select("task_id")
            .where("id", "=", conversationId),
        );
        if (Option.isNone(rowOpt)) {
          return yield* Effect.fail(
            new ConversationNotFoundError({
              message: MSG_CONVERSATION_NOT_FOUND,
            }),
          );
        }
        return rowOpt.value.task_id;
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
      Effect.gen(this, function* (this: ConversationService) {
        const rowOpt = yield* takeFirstOption(
          this.db
            .selectFrom("conversations")
            .selectAll()
            .where("id", "=", conversationId),
        );
        if (Option.isNone(rowOpt)) {
          return yield* Effect.fail(
            new ConversationNotFoundError({
              message: MSG_CONVERSATION_NOT_FOUND,
            }),
          );
        }
        return this.mapConversation(rowOpt.value);
      }),
    );
  }

  /**
   * Authorizing app for a conversation. The routing key every app-authority
   * gate compares against, read without joining the task that minted the
   * conversation.
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
      Effect.gen(this, function* (this: ConversationService) {
        const rows = yield* this.db
          .selectFrom("conversation_participants")
          .select("conversation_id")
          .where("agent_id", "=", agentId);
        return rows.map((r) => r.conversation_id);
      }),
    );
  }

  assertConversationParticipant(
    conversationId: ConversationId,
    agentId: AgentId,
  ): Effect.Effect<void, ForbiddenError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* (this: ConversationService) {
        const rowOpt = yield* takeFirstOption(
          this.db
            .selectFrom("conversation_participants")
            .select(sql`1`.as("exists"))
            .where("conversation_id", "=", conversationId)
            .where("agent_id", "=", agentId),
        );

        if (Option.isNone(rowOpt)) {
          return yield* Effect.fail(
            new ForbiddenError({
              message: "Not a participant in this conversation",
            }),
          );
        }
      }),
    );
  }

  /**
   * Enforces contact policy for each requested target.
   * @param input Input value to process.
   * @internal
   * @returns The creator opt result.
   */
  assertCreatorContactsAll(
    input: CreatorContactPolicyInput,
  ): Effect.Effect<void, AgentNotFoundError | NotInContactsError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* (this: ConversationService) {
        const creatorOpt = yield* takeFirstOption(
          this.db
            .selectFrom("agents")
            .select(["owner_user_id"])
            .where("id", "=", input.creatorAgentId),
        );
        if (Option.isNone(creatorOpt)) {
          return yield* Effect.fail(
            new AgentNotFoundError({
              message: `Agent ${input.creatorAgentId} not found`,
            }),
          );
        }
        const creatorOwner = creatorOpt.value.owner_user_id;
        for (const targetAgentId of input.targetAgentIds) {
          const targetOwner = input.ownerByAgentId.get(targetAgentId);
          if (targetOwner === undefined) {
            return yield* Effect.fail(
              new AgentNotFoundError({
                message: `Agent ${targetAgentId} not found`,
              }),
            );
          }
          yield* this.checkContactEdge({
            requesterAgentId: input.creatorAgentId,
            requesterOwnerUserId: creatorOwner,
            targetAgentId,
            targetOwnerUserId: targetOwner,
            policy: input.policy,
          });
        }
      }),
    );
  }

  /**
   * Checks one contact-policy edge.
   * @param input Input value to process.
   * @internal
   * @returns The allowed result.
   */
  checkContactEdge(
    input: ContactEdgeInput,
  ): Effect.Effect<void, NotInContactsError> {
    return Effect.gen(this, function* (this: ConversationService) {
      const allowed = yield* input.policy(
        input.requesterOwnerUserId,
        input.targetOwnerUserId,
      );
      if (!allowed) {
        yield* Effect.logInfo("Contact policy denied").pipe(
          Effect.annotateLogs({
            requesterAgentId: input.requesterAgentId,
            targetAgentId: input.targetAgentId,
            requesterOwner: input.requesterOwnerUserId,
            targetOwner: input.targetOwnerUserId,
          }),
        );
        return yield* Effect.fail(
          new NotInContactsError({
            message: `Contact policy does not allow this edge`,
          }),
        );
      }
    });
  }

  private mapConversation(row: ConversationColumns): Conversation {
    return {
      id: row.id,
      name: row.name ?? undefined,
      createdBy: row.created_by_id,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }
}
