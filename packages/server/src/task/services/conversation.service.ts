import type { Db } from "../../db/client.js";
import type {
  Conversation,
  ConversationParticipant,
  ConversationSummary,
} from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId, TaskId } from "@moltzap/protocol/task";
import type { SqlError } from "@effect/sql/SqlError";
import { Cause, Effect, Option } from "effect";
import { InvalidParamsError } from "../../runtime/index.js";
import {
  ConversationArchivedError,
  ConversationFullError,
  ForbiddenError,
  NotFoundError,
  NotInContactsError,
  ParticipantsAddedNotificationDefinition,
  ParticipantsRemovedNotificationDefinition,
} from "@moltzap/protocol";
import { ParticipantService } from "../../identity/services/participant.service.js";
import type { ConnectionManager } from "../../transport/connection.js";
import { opaquePayload } from "../../network/network-send.js";
import { sql } from "../../db/sql.js";
import {
  catchSqlErrorAsDefect,
  rawQuery,
  takeFirstOption,
  takeFirstOrFail,
  transaction,
} from "../../db/effect-kysely-toolkit.js";
import { assertConversationAdminAuthority } from "./conversation-admin-authority.js";
import type {
  AddParticipantOptions,
  ContactEdgeInput,
  ContactPolicyResolver,
  ConversationArchiveFilter,
  ConversationColumns,
  CreateConversationOptions,
  CreatorContactPolicyInput,
  ListRow,
  ParticipantAddedBroadcast,
  ParticipantInsertResult,
  ParticipantRemovedBroadcast,
  ParticipantRow,
} from "./conversation-service-types.js";

export type {
  ContactPolicyCheck,
  ContactPolicyResolver,
  CreateConversationOptions,
} from "./conversation-service-types.js";

export type ConversationServiceError =
  | ConversationArchivedError
  | ConversationFullError
  | ForbiddenError
  | InvalidParamsError
  | NotFoundError
  | NotInContactsError;

const MAX_GROUP_PARTICIPANTS = 256;
const GROUP_OVERFLOW_MSG = `Group cannot exceed ${MAX_GROUP_PARTICIPANTS} participants`;
const PREVIEW_CACHE_MAX = 2000;
const PREVIEW_CACHE_TEXT_CHARS = 80;
const DEFAULT_CONVERSATION_LIST_LIMIT = 50;
const MSG_CONVERSATION_NOT_FOUND = "Conversation not found";
const MSG_NOT_A_PARTICIPANT = "Not a participant";

export class ConversationService {
  /** In-memory cache for last message previews — avoids decrypting on every list() call */
  private previewCache = new Map<ConversationId, string>();

  constructor(
    private db: Db,
    private participants: ParticipantService,
    private connections: ConnectionManager,
    private resolveContactPolicy: ContactPolicyResolver = () => null,
  ) {}

  /** Writes the plaintext preview before message-part encryption. */
  updatePreviewCache(
    conversationId: ConversationId,
    firstPartText: string,
  ): void {
    this.previewCache.delete(conversationId);
    this.previewCache.set(
      conversationId,
      firstPartText.slice(0, PREVIEW_CACHE_TEXT_CHARS),
    );
    if (this.previewCache.size > PREVIEW_CACHE_MAX) {
      const oldest = this.previewCache.keys().next().value!;
      this.previewCache.delete(oldest);
    }
  }

  create<TaskMintError = never>(
    input: CreateConversationOptions<TaskMintError>,
  ): Effect.Effect<Conversation, ConversationServiceError | TaskMintError> {
    return catchSqlErrorAsDefect(this.createConversationEffect(input));
  }

  private createConversationEffect<TaskMintError>(
    input: CreateConversationOptions<TaskMintError>,
  ): Effect.Effect<
    Conversation,
    ConversationServiceError | TaskMintError | SqlError
  > {
    return Effect.gen(this, function* () {
      const ownerByAgentId = yield* this.loadAgentOwners(input.agentIds);
      const existingDm = yield* this.existingDmForCreate(input);
      if (existingDm !== null) return existingDm;

      yield* this.assertContactPolicyForCreate(
        input.creatorAgentId,
        input.agentIds,
        input.type,
        ownerByAgentId,
      );
      yield* this.assertGroupCapacityForCreate(input.type, input.agentIds);

      const task = yield* input.mintTask;
      const created = yield* this.insertConversation(input, task.id);
      this.subscribeCreatedConversation(input, created.id);
      yield* this.logConversationCreated(input, created.id);
      return created;
    });
  }

  /**
   * Package-private existence helper consumed by `obtainAgentExists` +
   * `obtainContactPolicyForCreate`. Spec E (#601) Decision B / Option A.
   * @internal
   */
  loadAgentOwners(
    agentIds: ReadonlyArray<AgentId>,
  ): Effect.Effect<
    ReadonlyMap<AgentId, string | null>,
    NotFoundError | SqlError
  > {
    return Effect.gen(this, function* () {
      const rows =
        agentIds.length === 0
          ? []
          : yield* this.db
              .selectFrom("agents")
              .select(["id", "owner_user_id"])
              .where("id", "in", [...agentIds]);
      const ownerByAgentId = new Map<AgentId, string | null>();
      for (const row of rows) {
        ownerByAgentId.set(row.id, row.owner_user_id);
      }
      for (const agentId of agentIds) {
        if (!ownerByAgentId.has(agentId)) {
          return yield* Effect.fail(
            new NotFoundError({ message: `Agent ${agentId} not found` }),
          );
        }
      }
      return ownerByAgentId;
    });
  }

  private existingDmForCreate<TaskMintError>(
    input: CreateConversationOptions<TaskMintError>,
  ): Effect.Effect<Conversation | null, ConversationServiceError> {
    if (input.type !== "dm") return Effect.succeed(null);
    if (input.agentIds.length !== 1) {
      return Effect.fail(
        new InvalidParamsError({
          message: "DM requires exactly one other participant",
        }),
      );
    }
    return this.findExistingDm(input.creatorAgentId, input.agentIds[0]!);
  }

  /**
   * Package-private contact-policy gate consumed by
   * `obtainContactPolicyForCreate`. Spec E (#601) Decision B / Option A.
   * @internal
   */
  assertContactPolicyForCreate(
    creatorAgentId: AgentId,
    targetAgentIds: ReadonlyArray<AgentId>,
    pathType: "dm" | "group",
    ownerByAgentId: ReadonlyMap<AgentId, string | null>,
  ): Effect.Effect<void, ConversationServiceError> {
    const policy = this.resolveContactPolicy();
    if (policy === null || targetAgentIds.length === 0) return Effect.void;
    return this.assertCreatorContactsAll({
      creatorAgentId,
      targetAgentIds,
      ownerByAgentId,
      policy,
      pathLabel: pathType,
    });
  }

  /**
   * Package-private capacity gate consumed by
   * `obtainGroupCapacityForCreate`. Spec E (#601) Decision B / Option A.
   * @internal
   */
  assertGroupCapacityForCreate(
    pathType: "dm" | "group",
    targetAgentIds: ReadonlyArray<AgentId>,
  ): Effect.Effect<void, ConversationFullError> {
    const overflow =
      pathType === "group" &&
      targetAgentIds.length + 1 > MAX_GROUP_PARTICIPANTS;
    if (!overflow) return Effect.void;
    return Effect.fail(
      new ConversationFullError({ message: GROUP_OVERFLOW_MSG }),
    );
  }

  private insertConversation<TaskMintError>(
    input: CreateConversationOptions<TaskMintError>,
    taskId: TaskId,
  ): Effect.Effect<Conversation, SqlError> {
    return transaction(this.db, (trx) =>
      Effect.gen(this, function* () {
        const conv = yield* takeFirstOrFail(
          trx
            .insertInto("conversations")
            .values({
              type: input.type,
              name: input.name ?? null,
              created_by_id: input.creatorAgentId,
              task_id: taskId,
            })
            .returningAll(),
        );
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
        return this.mapConversation(conv);
      }),
    );
  }

  private subscribeCreatedConversation<TaskMintError>(
    input: CreateConversationOptions<TaskMintError>,
    conversationId: ConversationId,
  ): void {
    this.connections.subscribeAgentsToConversation(
      [input.creatorAgentId, ...input.agentIds],
      conversationId,
    );
  }

  private logConversationCreated<TaskMintError>(
    input: CreateConversationOptions<TaskMintError>,
    conversationId: ConversationId,
  ): Effect.Effect<void> {
    return Effect.logInfo("Conversation created").pipe(
      Effect.annotateLogs({
        conversationId,
        type: input.type,
        participantCount: input.agentIds.length + 1,
      }),
    );
  }

  /**
   * Resolve an `agent:&lt;name>` DM target and ensure a conversation
   * exists. Used by `messages/send` when the caller supplies
   * `to: "agent:&lt;name>"` instead of a known conversationId. The task
   * source is lazy (#464) so a dedup hit short-circuits without
   * minting.
   */
  createDmByAgentName<TaskMintError = never>(
    agentName: string,
    creatorAgentId: AgentId,
    mintTask: Effect.Effect<{ id: TaskId }, TaskMintError>,
  ): Effect.Effect<Conversation, ConversationServiceError | TaskMintError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const target = yield* takeFirstOption(
          this.db
            .selectFrom("agents")
            .select(["id"])
            .where("name", "=", agentName)
            .where("status", "=", "active"),
        );
        if (Option.isNone(target)) {
          return yield* Effect.fail(
            new NotFoundError({ message: `Agent '${agentName}' not found` }),
          );
        }
        return yield* this.create({
          type: "dm",
          name: undefined,
          agentIds: [target.value.id],
          creatorAgentId,
          mintTask,
        });
      }),
    );
  }

  list(
    agentId: AgentId,
    limit = DEFAULT_CONVERSATION_LIST_LIMIT,
    cursor?: string,
    archived: ConversationArchiveFilter = "exclude",
  ): Effect.Effect<
    { conversations: ConversationSummary[]; cursor?: string },
    InvalidParamsError
  > {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const cursorParam = yield* this.parseListCursor(cursor);
        const rows = yield* this.queryConversationListRows({
          agentId,
          limit,
          cursorParam,
          archived,
        });
        const hasMore = rows.length > limit;
        const resultRows = hasMore ? rows.slice(0, limit) : rows;
        const conversations = this.conversationSummariesFromRows(resultRows);
        yield* this.attachSummaryParticipants(conversations);
        return {
          conversations,
          cursor: this.nextConversationListCursor(hasMore, resultRows),
        };
      }),
    );
  }

  private parseListCursor(
    cursor: string | undefined,
  ): Effect.Effect<string | null, InvalidParamsError> {
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
  }

  private queryConversationListRows(input: {
    readonly agentId: AgentId;
    readonly limit: number;
    readonly cursorParam: string | null;
    readonly archived: ConversationArchiveFilter;
  }): Effect.Effect<ReadonlyArray<ListRow>, SqlError> {
    return rawQuery(
      this.db,
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
        WHERE cp.agent_id = ${input.agentId}
          ${this.archivedListFilter(input.archived)}
          ${this.cursorListFilter(input.cursorParam)}
        ORDER BY COALESCE(m.created_at, c.updated_at) DESC
        LIMIT ${input.limit + 1}
      `,
    );
  }

  private archivedListFilter(archived: ConversationArchiveFilter) {
    switch (archived) {
      case "only":
        return sql`AND c.archived_at IS NOT NULL`;
      case "include":
        return sql``;
      case "exclude":
        return sql`AND c.archived_at IS NULL`;
    }
  }

  private cursorListFilter(cursorParam: string | null) {
    if (cursorParam === null) return sql``;
    return sql`AND c.updated_at < ${cursorParam}`;
  }

  private conversationSummariesFromRows(
    rows: ReadonlyArray<ListRow>,
  ): ConversationSummary[] {
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      name: row.name ?? undefined,
      lastMessagePreview: this.previewCache.get(row.id),
      lastMessageTimestamp: row.last_message_at?.toISOString(),
      unreadCount: row.unread_count,
    }));
  }

  private attachSummaryParticipants(
    conversations: ConversationSummary[],
  ): Effect.Effect<void, SqlError> {
    if (conversations.length === 0) return Effect.void;
    return Effect.gen(this, function* () {
      const convIds = conversations.map((conversation) => conversation.id);
      const rows = yield* this.db
        .selectFrom("conversation_participants")
        .select(["conversation_id", "agent_id"])
        .where("conversation_id", "in", convIds);
      const partsByConv = this.participantRefsByConversation(rows);
      for (const conversation of conversations) {
        conversation.participants = partsByConv.get(conversation.id) ?? [];
      }
    });
  }

  private participantRefsByConversation(
    rows: ReadonlyArray<{ conversation_id: ConversationId; agent_id: AgentId }>,
  ): Map<ConversationId, Array<{ type: "agent"; id: AgentId }>> {
    const partsByConv = new Map<
      ConversationId,
      Array<{ type: "agent"; id: AgentId }>
    >();
    for (const row of rows) {
      const participants = partsByConv.get(row.conversation_id) ?? [];
      participants.push({ type: "agent", id: row.agent_id });
      partsByConv.set(row.conversation_id, participants);
    }
    return partsByConv;
  }

  private nextConversationListCursor(
    hasMore: boolean,
    rows: ReadonlyArray<ListRow>,
  ): string | undefined {
    if (!hasMore) return undefined;
    return rows[rows.length - 1]?.updated_at.toISOString();
  }

  get(
    conversationId: ConversationId,
    requesterAgentId: AgentId,
  ): Effect.Effect<
    {
      conversation: Conversation;
      participants: ConversationParticipant[];
    },
    ConversationServiceError
  > {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        yield* this.assertConversationParticipant(
          conversationId,
          requesterAgentId,
        );
        const convOpt = yield* takeFirstOption(
          this.db
            .selectFrom("conversations")
            .selectAll()
            .where("id", "=", conversationId),
        );
        if (Option.isNone(convOpt)) {
          return yield* Effect.fail(
            new NotFoundError({ message: MSG_CONVERSATION_NOT_FOUND }),
          );
        }
        const partRows = yield* this.db
          .selectFrom("conversation_participants as cp")
          .leftJoin("agents as a", "a.id", "cp.agent_id")
          .select([
            "cp.conversation_id",
            "cp.agent_id",
            "cp.joined_at",
            "cp.last_read_seq",
            "cp.muted_until",
            "a.name as agent_name",
            "a.display_name as agent_display_name",
          ])
          .where("cp.conversation_id", "=", conversationId);
        return {
          conversation: this.mapConversation(convOpt.value),
          participants: partRows.map((row) => this.mapParticipant(row)),
        };
      }),
    );
  }

  update(
    conversationId: ConversationId,
    name: string | undefined,
    requesterAgentId: AgentId,
  ): Effect.Effect<Conversation, ConversationServiceError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        yield* assertConversationAdminAuthority(
          this.db,
          conversationId,
          requesterAgentId,
        );

        const rowOpt = yield* takeFirstOption(
          this.db
            .updateTable("conversations")
            .set({ name: name ?? null })
            .where("id", "=", conversationId)
            .returningAll(),
        );

        if (Option.isNone(rowOpt)) {
          return yield* Effect.fail(
            new NotFoundError({ message: MSG_CONVERSATION_NOT_FOUND }),
          );
        }

        return this.mapConversation(rowOpt.value);
      }),
    );
  }

  archive(
    conversationId: ConversationId,
    agentId: AgentId,
  ): Effect.Effect<{ archivedAt: string }, ConversationServiceError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        yield* assertConversationAdminAuthority(
          this.db,
          conversationId,
          agentId,
        );

        const updatedOpt = yield* takeFirstOption(
          this.db
            .updateTable("conversations")
            .set({ archived_at: new Date() })
            .where("id", "=", conversationId)
            .where("archived_at", "is", null)
            .returning("archived_at"),
        );
        if (Option.isSome(updatedOpt)) {
          return { archivedAt: updatedOpt.value.archived_at!.toISOString() };
        }

        // No transition happened: already archived, or a concurrent caller
        // won the UPDATE. Re-read to return the winner's timestamp.
        const currentOpt = yield* takeFirstOption(
          this.db
            .selectFrom("conversations")
            .select("archived_at")
            .where("id", "=", conversationId),
        );
        if (Option.isNone(currentOpt) || !currentOpt.value.archived_at) {
          return yield* Effect.fail(
            new NotFoundError({ message: MSG_CONVERSATION_NOT_FOUND }),
          );
        }
        return { archivedAt: currentOpt.value.archived_at.toISOString() };
      }),
    );
  }

  unarchive(
    conversationId: ConversationId,
    agentId: AgentId,
  ): Effect.Effect<void, ConversationServiceError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        yield* assertConversationAdminAuthority(
          this.db,
          conversationId,
          agentId,
        );

        yield* this.db
          .updateTable("conversations")
          .set({ archived_at: null })
          .where("id", "=", conversationId)
          .where("archived_at", "is not", null);
      }),
    );
  }

  leave(
    conversationId: ConversationId,
    agentId: AgentId,
  ): Effect.Effect<void, ConversationServiceError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const convOpt = yield* takeFirstOption(
          this.db
            .selectFrom("conversations")
            .select("type")
            .where("id", "=", conversationId),
        );

        if (Option.isNone(convOpt)) {
          return yield* Effect.fail(
            new NotFoundError({ message: MSG_CONVERSATION_NOT_FOUND }),
          );
        }
        if (convOpt.value.type === "dm") {
          return yield* Effect.fail(
            new InvalidParamsError({ message: "Cannot leave a DM" }),
          );
        }

        const deleted = yield* this.db
          .deleteFrom("conversation_participants")
          .where("conversation_id", "=", conversationId)
          .where("agent_id", "=", agentId)
          .returning("conversation_id");

        if (deleted.length === 0) {
          return yield* Effect.fail(
            new NotFoundError({ message: MSG_NOT_A_PARTICIPANT }),
          );
        }
      }),
    );
  }

  addParticipant(
    conversationId: ConversationId,
    agentId: AgentId,
    requesterAgentId: AgentId,
  ): Effect.Effect<ConversationParticipant, ConversationServiceError> {
    return catchSqlErrorAsDefect(
      this.addParticipantEffect({ conversationId, agentId, requesterAgentId }),
    );
  }

  private addParticipantEffect(
    input: AddParticipantOptions,
  ): Effect.Effect<
    ConversationParticipant,
    ConversationServiceError | SqlError | Cause.NoSuchElementException
  > {
    return Effect.gen(this, function* () {
      yield* this.assertAddParticipantAuthority(input);
      const targetOwnerUserId = yield* this.participants.assertAgentExists(
        input.agentId,
      );
      yield* this.assertAddParticipantContactPolicy(
        input.requesterAgentId,
        input.agentId,
        targetOwnerUserId,
      );
      yield* this.assertParticipantCapacity(input.conversationId);

      const inserted = yield* this.insertParticipant(input);
      this.subscribeAddedParticipant(input);
      yield* this.publishParticipantAdded(input, inserted);
      return this.mapParticipant(inserted.row);
    });
  }

  /**
   * Spec E (#601) Decision B / Option A — package-private add-
   * participant authority gate. Consumed by D1's add-participant
   * handler (post-D3 routes through `TmAuthority`).
   * @internal
   */
  assertAddParticipantAuthority(
    input: AddParticipantOptions,
  ): Effect.Effect<void, ConversationServiceError | SqlError> {
    return Effect.gen(this, function* () {
      yield* assertConversationAdminAuthority(
        this.db,
        input.conversationId,
        input.requesterAgentId,
      );
      const convOpt = yield* takeFirstOption(
        this.db
          .selectFrom("conversations")
          .select("type")
          .where("id", "=", input.conversationId),
      );
      if (Option.isNone(convOpt)) {
        return yield* Effect.fail(
          new NotFoundError({ message: MSG_CONVERSATION_NOT_FOUND }),
        );
      }
      if (convOpt.value.type === "dm") {
        return yield* Effect.fail(
          new InvalidParamsError({
            message: "Cannot add participants to a DM conversation",
          }),
        );
      }
    });
  }

  /**
   * Package-private add-participant contact-policy gate consumed by
   * `obtainContactPolicyForAdd`. Spec E (#601) Decision B / Option A.
   * @internal
   */
  assertAddParticipantContactPolicy(
    requesterAgentId: AgentId,
    targetAgentId: AgentId,
    targetOwnerUserId: string | null,
  ): Effect.Effect<void, ConversationServiceError> {
    const policy = this.resolveContactPolicy();
    if (policy === null) return Effect.void;
    return Effect.gen(this, function* () {
      const requester = yield* this.participants.resolve(requesterAgentId);
      if (!requester.exists) {
        return yield* Effect.fail(
          new NotFoundError({ message: `Agent ${requesterAgentId} not found` }),
        );
      }
      yield* this.checkContactEdge({
        requesterAgentId,
        requesterOwnerUserId: requester.ownerUserId,
        targetAgentId,
        targetOwnerUserId,
        policy,
        pathLabel: "addParticipant",
      });
    });
  }

  /**
   * Spec E (#601) Decision B / Option A — package-private participant-
   * capacity gate. Survives as an internal collaborator of
   * `addParticipantEffect`; no direct capability binding.
   * @internal
   */
  assertParticipantCapacity(
    conversationId: ConversationId,
  ): Effect.Effect<
    void,
    ConversationFullError | SqlError | Cause.NoSuchElementException
  > {
    return Effect.gen(this, function* () {
      const countRow = yield* takeFirstOrFail(
        this.db
          .selectFrom("conversation_participants")
          .select(sql<number>`COUNT(*)::int`.as("count"))
          .where("conversation_id", "=", conversationId),
        "count not returned",
      );
      if (countRow.count >= MAX_GROUP_PARTICIPANTS) {
        return yield* Effect.fail(
          new ConversationFullError({ message: GROUP_OVERFLOW_MSG }),
        );
      }
    });
  }

  private insertParticipant(
    input: AddParticipantOptions,
  ): Effect.Effect<
    ParticipantInsertResult,
    SqlError | Cause.NoSuchElementException
  > {
    return Effect.gen(this, function* () {
      const insertedOpt = yield* takeFirstOption(
        this.db
          .insertInto("conversation_participants")
          .values({
            conversation_id: input.conversationId,
            agent_id: input.agentId,
          })
          .onConflict((oc) =>
            oc.columns(["conversation_id", "agent_id"]).doNothing(),
          )
          .returningAll(),
      );
      const row = Option.isSome(insertedOpt)
        ? insertedOpt.value
        : yield* this.readParticipant(input);
      return { row, wasAlreadyMember: Option.isNone(insertedOpt) };
    });
  }

  private readParticipant(
    input: AddParticipantOptions,
  ): Effect.Effect<ParticipantRow, SqlError | Cause.NoSuchElementException> {
    return takeFirstOrFail(
      this.db
        .selectFrom("conversation_participants")
        .selectAll()
        .where("conversation_id", "=", input.conversationId)
        .where("agent_id", "=", input.agentId),
      "participant row vanished after onConflict",
    );
  }

  private subscribeAddedParticipant(input: AddParticipantOptions): void {
    this.connections.subscribeAgentsToConversation(
      [input.agentId],
      input.conversationId,
    );
  }

  private publishParticipantAdded(
    input: AddParticipantOptions,
    inserted: ParticipantInsertResult,
  ): Effect.Effect<void, SqlError> {
    if (inserted.wasAlreadyMember) return Effect.void;
    return Effect.gen(this, function* () {
      const participants = yield* this.getParticipantAgentIds(
        input.conversationId,
      );
      yield* this.broadcastParticipantsAdded({
        conversationId: input.conversationId,
        targetAgentIds: participants,
        addedAgentId: input.agentId,
        addedBy: input.requesterAgentId,
        addedAt: inserted.row.joined_at,
      });
    });
  }

  removeParticipant(
    conversationId: ConversationId,
    agentId: AgentId,
    requesterAgentId: AgentId,
  ): Effect.Effect<void, ConversationServiceError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        yield* assertConversationAdminAuthority(
          this.db,
          conversationId,
          requesterAgentId,
        );

        // Snapshot BEFORE delete so the about-to-be-removed agent stays
        // in the fan-out target list. The membership row is still live
        // at this point so the snapshot includes them.
        const participantsSnapshot =
          yield* this.getParticipantAgentIds(conversationId);

        const deleted = yield* this.db
          .deleteFrom("conversation_participants")
          .where("conversation_id", "=", conversationId)
          .where("agent_id", "=", agentId)
          .returning("conversation_id");

        if (deleted.length === 0) {
          return yield* Effect.fail(
            new NotFoundError({
              message: "Participant not found",
            }),
          );
        }

        const removedAt = new Date();
        yield* this.broadcastParticipantsRemoved({
          conversationId,
          targetAgentIds: participantsSnapshot,
          removedAgentId: agentId,
          removedBy: requesterAgentId,
          removedAt,
        });

        for (const conn of this.connections.getByAgent(agentId)) {
          conn.conversationIds.delete(conversationId);
        }
      }),
    );
  }

  // PGlite's Kysely dialect returns numUpdatedRows: 0n on UPDATE even when rows match.
  // Use .returning().execute() and check rows.length instead.
  mute(
    conversationId: ConversationId,
    agentId: AgentId,
    until?: string,
  ): Effect.Effect<void, ConversationServiceError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const mutedUntil = until ?? "9999-12-31T23:59:59+00:00";
        const rows = yield* this.db
          .updateTable("conversation_participants")
          .set({ muted_until: sql`${mutedUntil}::timestamptz` })
          .where("conversation_id", "=", conversationId)
          .where("agent_id", "=", agentId)
          .returning("conversation_id");
        if (rows.length === 0) {
          return yield* Effect.fail(
            new NotFoundError({ message: MSG_NOT_A_PARTICIPANT }),
          );
        }
      }),
    );
  }

  unmute(
    conversationId: ConversationId,
    agentId: AgentId,
  ): Effect.Effect<void, ConversationServiceError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rows = yield* this.db
          .updateTable("conversation_participants")
          .set({ muted_until: sql.lit(null) })
          .where("conversation_id", "=", conversationId)
          .where("agent_id", "=", agentId)
          .returning("conversation_id");
        if (rows.length === 0) {
          return yield* Effect.fail(
            new NotFoundError({ message: MSG_NOT_A_PARTICIPANT }),
          );
        }
      }),
    );
  }

  getParticipantAgentIds(
    conversationId: ConversationId,
  ): Effect.Effect<readonly AgentId[]> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rows = yield* this.db
          .selectFrom("conversation_participants")
          .select("agent_id")
          .where("conversation_id", "=", conversationId);

        return rows.map((r) => r.agent_id);
      }),
    );
  }

  getConversationIds(agentId: AgentId): Effect.Effect<ConversationId[]> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
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
      Effect.gen(this, function* () {
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

  private broadcastParticipantsAdded(
    input: ParticipantAddedBroadcast,
  ): Effect.Effect<void> {
    return Effect.sync(() => {
      const frame = ParticipantsAddedNotificationDefinition.encode({
        conversationId: input.conversationId,
        agentId: input.addedAgentId,
        addedBy: input.addedBy,
        addedAt: input.addedAt.toISOString(),
      });
      const payload = opaquePayload(JSON.stringify(frame));
      this.fanOutToAgents(input.targetAgentIds, payload);
    });
  }

  private broadcastParticipantsRemoved(
    input: ParticipantRemovedBroadcast,
  ): Effect.Effect<void> {
    return Effect.sync(() => {
      const frame = ParticipantsRemovedNotificationDefinition.encode({
        conversationId: input.conversationId,
        agentId: input.removedAgentId,
        removedBy: input.removedBy,
        removedAt: input.removedAt.toISOString(),
      });
      const payload = opaquePayload(JSON.stringify(frame));
      this.fanOutToAgents(input.targetAgentIds, payload);
    });
  }

  private fanOutToAgents(
    agentIds: readonly AgentId[],
    payload: ReturnType<typeof opaquePayload>,
  ): void {
    for (const agentId of agentIds) {
      for (const conn of this.connections.getByAgent(agentId)) {
        if (conn.auth === null) continue;
        const connId = conn.id;
        Effect.runFork(
          conn
            .write(payload)
            .pipe(
              Effect.catchAll((cause) =>
                Effect.logWarning(
                  "participants notification: socket write failed",
                ).pipe(Effect.annotateLogs({ connId, cause: String(cause) })),
              ),
            ),
        );
      }
    }
  }

  /**
   * Package-private creator-contact-policy fan-out consumed transitively
   * via `assertContactPolicyForCreate`. Spec E (#601) Decision B / Option A.
   * @internal
   */
  assertCreatorContactsAll(
    input: CreatorContactPolicyInput,
  ): Effect.Effect<void, ConversationServiceError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const creatorOpt = yield* takeFirstOption(
          this.db
            .selectFrom("agents")
            .select(["owner_user_id"])
            .where("id", "=", input.creatorAgentId),
        );
        if (Option.isNone(creatorOpt)) {
          return yield* Effect.fail(
            new NotFoundError({
              message: `Agent ${input.creatorAgentId} not found`,
            }),
          );
        }
        const creatorOwner = creatorOpt.value.owner_user_id;
        for (const targetAgentId of input.targetAgentIds) {
          if (!input.ownerByAgentId.has(targetAgentId)) {
            return yield* Effect.fail(
              new NotFoundError({
                message: `Agent ${targetAgentId} not found`,
              }),
            );
          }
          const targetOwner = input.ownerByAgentId.get(targetAgentId) ?? null;
          yield* this.checkContactEdge({
            requesterAgentId: input.creatorAgentId,
            requesterOwnerUserId: creatorOwner,
            targetAgentId,
            targetOwnerUserId: targetOwner,
            policy: input.policy,
            pathLabel: input.pathLabel,
          });
        }
      }),
    );
  }

  /**
   * Package-private single-edge contact-policy probe consumed by
   * `assertCreatorContactsAll` and `assertAddParticipantContactPolicy`.
   * Spec E (#601) Decision B / Option A.
   * @internal
   */
  checkContactEdge(
    input: ContactEdgeInput,
  ): Effect.Effect<void, ConversationServiceError> {
    return Effect.gen(this, function* () {
      if (!input.requesterOwnerUserId || !input.targetOwnerUserId) {
        return yield* Effect.fail(
          new NotInContactsError({
            message: `Contact policy (${input.pathLabel}) requires both agents to have an owner`,
          }),
        );
      }
      const allowed = yield* input.policy(
        input.requesterOwnerUserId,
        input.targetOwnerUserId,
      );
      if (!allowed) {
        yield* Effect.logInfo("Contact policy denied").pipe(
          Effect.annotateLogs({
            pathLabel: input.pathLabel,
            requesterAgentId: input.requesterAgentId,
            targetAgentId: input.targetAgentId,
            requesterOwner: input.requesterOwnerUserId,
            targetOwner: input.targetOwnerUserId,
          }),
        );
        return yield* Effect.fail(
          new NotInContactsError({
            message: `Contact policy (${input.pathLabel}) does not allow this edge`,
          }),
        );
      }
    });
  }

  private findExistingDm(
    agentIdA: AgentId,
    agentIdB: AgentId,
  ): Effect.Effect<Conversation | null, ConversationServiceError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rows = yield* rawQuery(
          this.db,
          sql<ConversationColumns>`
            SELECT c.* FROM conversations c
            WHERE c.type = 'dm'
            AND c.archived_at IS NULL
            AND EXISTS (
              SELECT 1 FROM conversation_participants cp
              WHERE cp.conversation_id = c.id
                AND cp.agent_id = ${agentIdA}
            )
            AND EXISTS (
              SELECT 1 FROM conversation_participants cp
              WHERE cp.conversation_id = c.id
                AND cp.agent_id = ${agentIdB}
            )
            LIMIT 1
          `,
        );

        if (rows.length === 0) return null;
        return this.mapConversation(rows[0]!);
      }),
    );
  }

  private mapConversation(row: ConversationColumns): Conversation {
    return {
      id: row.id,
      type: row.type,
      name: row.name ?? undefined,
      createdBy: row.created_by_id,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private mapParticipant(row: ParticipantRow): ConversationParticipant {
    return {
      conversationId: row.conversation_id,
      participant: {
        type: "agent" as const,
        id: row.agent_id,
      },
      joinedAt: row.joined_at.toISOString(),
      lastReadMessageId:
        row.last_read_message_id == null ? undefined : row.last_read_message_id,
      mutedUntil: row.muted_until ? row.muted_until.toISOString() : undefined,
      agentName: row.agent_name ?? undefined,
      agentDisplayName: row.agent_display_name ?? undefined,
    };
  }
}
