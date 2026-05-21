import type { Db } from "../../db/client.js";
import type {
  Conversation,
  ConversationParticipant,
  ConversationSummary,
} from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId, TaskId } from "@moltzap/protocol/task";
import type { SqlError } from "@effect/sql/SqlError";
import { Effect, Option } from "effect";
import { InvalidParamsError } from "../../runtime/index.js";
import {
  ConversationArchivedError,
  ConversationFullError,
  ForbiddenError,
  NotFoundError,
  NotInContactsError,
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
import { listConversations } from "./conversation/list-pagination.js";
import {
  ConversationCreateAuthorization,
  obtainConversationCreateAuthorization,
} from "../../app/capabilities/index.js";
import { ConversationServiceTag } from "../../app/layers.js";
import type {
  ContactEdgeInput,
  ContactPolicyResolver,
  ConversationArchiveFilter,
  ConversationColumns,
  CreateConversationOptions,
  CreatorContactPolicyInput,
  ParticipantRow,
} from "./conversation-service-types.js";

export type {
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
  ): Effect.Effect<
    Conversation,
    ConversationServiceError | TaskMintError,
    ConversationCreateAuthorization
  > {
    return catchSqlErrorAsDefect(this.createConversationEffect(input));
  }

  private createConversationEffect<TaskMintError>(
    input: CreateConversationOptions<TaskMintError>,
  ): Effect.Effect<
    Conversation,
    ConversationServiceError | TaskMintError | SqlError,
    ConversationCreateAuthorization
  > {
    return Effect.gen(this, function* () {
      const auth = yield* ConversationCreateAuthorization;
      if (auth._tag === "ExistingDm") return auth.conversation;
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

  /**
   * Package-private DM-dedup probe consumed by
   * `obtainConversationCreateAuthorization`. Spec E (#601) Decision C +
   * Decision B / Option A. Narrowed to the three fields the probe
   * actually reads (type, agentIds, creatorAgentId).
   * @internal
   */
  existingDmForCreate(input: {
    readonly type: "dm" | "group";
    readonly agentIds: ReadonlyArray<AgentId>;
    readonly creatorAgentId: AgentId;
  }): Effect.Effect<Conversation | null, ConversationServiceError> {
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
   * Spec D3 reduced-surface removeParticipant: NO broadcast, NO authority
   * gate. Used by `AppHost.removeDeniedParticipant` for dispatch-deny
   * eviction — that path runs server-internally, not via the wire RPC
   * (which is deleted in Commit 10). The broadcast was tied to the now-
   * deleted `conversations/participants/removed` notification.
   * @internal
   */
  removeParticipant(
    conversationId: ConversationId,
    agentId: AgentId,
    _requesterAgentId: AgentId,
  ): Effect.Effect<void, ConversationServiceError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const deleted = yield* this.db
          .deleteFrom("conversation_participants")
          .where("conversation_id", "=", conversationId)
          .where("agent_id", "=", agentId)
          .returning("conversation_id");
        if (deleted.length === 0) {
          return yield* Effect.fail(
            new NotFoundError({ message: "Participant not found" }),
          );
        }
        for (const conn of this.connections.getByAgent(agentId)) {
          conn.conversationIds.delete(conversationId);
        }
      }),
    );
  }

  /**
   * Package-private add-participant contact-policy gate consumed by
   * `obtainContactPolicyForAdd` (TaskConversationAddParticipant path).
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
        }).pipe(
          Effect.provideServiceEffect(
            ConversationCreateAuthorization,
            obtainConversationCreateAuthorization({
              type: "dm",
              agentIds: [target.value.id],
              creatorAgentId,
            }),
          ),
          // `createDmByAgentName` resolves the target agentId by
          // looking it up via name — the handler can't pre-compute
          // the obtain helper above. We satisfy the obtain helper's
          // `ConversationServiceTag` dependency inline with `this`.
          Effect.provideService(ConversationServiceTag, this),
        );
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
    return listConversations(
      { db: this.db, previewCache: this.previewCache },
      { agentId, limit, cursor, archived },
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

  /**
   * Spec D1 (#598) — parent task lookup for `task/conversation/list`
   * row projection. Fails with `NotFoundError` when the conversation
   * row is missing. `task_id` is `NOT NULL` per Phase 9b R12 so the
   * column is non-nullable; the only failure mode is "row missing".
   * @internal
   */
  taskIdForConversation(
    conversationId: ConversationId,
  ): Effect.Effect<TaskId, NotFoundError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rowOpt = yield* takeFirstOption(
          this.db
            .selectFrom("conversations")
            .select("task_id")
            .where("id", "=", conversationId),
        );
        if (Option.isNone(rowOpt)) {
          return yield* Effect.fail(
            new NotFoundError({ message: MSG_CONVERSATION_NOT_FOUND }),
          );
        }
        return rowOpt.value.task_id;
      }),
    );
  }

  /**
   * Spec D1 (#598) — by-id projection used by `task/conversation/*`
   * archive/unarchive handlers to surface the post-mutation
   * `Conversation` row (with populated `archivedAt`) for the
   * dual-emit `conversations/*` legacy notification fan-out. Fails
   * with `NotFoundError` when the row is missing.
   * @internal
   */
  loadById(
    conversationId: ConversationId,
  ): Effect.Effect<Conversation, NotFoundError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rowOpt = yield* takeFirstOption(
          this.db
            .selectFrom("conversations")
            .selectAll()
            .where("id", "=", conversationId),
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
      archivedAt: row.archived_at ? row.archived_at.toISOString() : undefined,
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
