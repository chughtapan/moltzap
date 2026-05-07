import type { Db } from "../db/client.js";
import type { ConversationType, ParticipantRole } from "../db/database.js";
import type {
  Conversation,
  ConversationParticipant,
  ConversationSummary,
} from "@moltzap/protocol";
import type { AgentId } from "@moltzap/protocol/identity";
import type { ConversationId, MessageId, TaskId } from "@moltzap/protocol/task";
import { Effect, Option } from "effect";
import { InvalidParamsError } from "../runtime/index.js";
import {
  ConflictError,
  ConversationArchivedError,
  ConversationFullError,
  ForbiddenError,
  NotFoundError,
  NotInContactsError,
} from "@moltzap/protocol";
import { ParticipantService } from "./participant.service.js";
import type { ConnectionManager } from "../ws/connection.js";
import { sql } from "kysely";
import {
  catchSqlErrorAsDefect,
  rawQuery,
  takeFirstOption,
  takeFirstOrFail,
  transaction,
} from "../db/effect-kysely-toolkit.js";

export type ConversationServiceError =
  | ConflictError
  | ConversationArchivedError
  | ConversationFullError
  | ForbiddenError
  | InvalidParamsError
  | NotFoundError
  | NotInContactsError;

const MAX_GROUP_PARTICIPANTS = 256;
const PREVIEW_CACHE_MAX = 2000;
const PREVIEW_CACHE_TEXT_CHARS = 80;
const DEFAULT_CONVERSATION_LIST_LIMIT = 50;
const MSG_CONVERSATION_NOT_FOUND = "Conversation not found";
const MSG_NOT_A_PARTICIPANT = "Not a participant";

/**
 * Policy gate consulted before any conversation edge (DM target,
 * group member, or `addParticipant` target) is created. Returns `true`
 * to allow the edge, `false` to deny it. The `Effect<_, never>` shape
 * mirrors {@link ContactService.areInContact} on AppHost —
 * implementations absorb webhook failures internally and surface a
 * boolean verdict.
 *
 * Passed as a lazy lookup (not a captured reference) because the
 * underlying service is registered on AppHost AFTER ConversationService
 * is constructed via `app.setContactService(...)` in `standalone.ts`.
 */
export type ContactPolicyCheck = (
  ownerUserIdA: string,
  ownerUserIdB: string,
) => Effect.Effect<boolean, never>;

/** Lazy resolver — `null` means "no policy configured, allow all". */
export type ContactPolicyResolver = () => ContactPolicyCheck | null;

interface ListRow {
  id: ConversationId;
  type: ConversationType;
  name: string | null;
  updated_at: Date;
  has_last_message: boolean;
  last_message_at: Date | null;
  unread_count: number;
}

interface ConversationColumns {
  id: ConversationId;
  type: ConversationType;
  name: string | null;
  created_by_id: AgentId;
  created_at: Date;
  updated_at: Date;
}

export class ConversationService {
  /** In-memory cache for last message previews — avoids decrypting on every list() call */
  private previewCache = new Map<ConversationId, string>();

  constructor(
    private db: Db,
    private participants: ParticipantService,
    private connections: ConnectionManager,
    private isAttachedToActiveSession: (
      convId: ConversationId,
    ) => boolean = () => false,
    /**
     * Lazy lookup for the active contact policy. Returns `null` when no
     * policy is wired (default for unit tests + dev mode), in which case
     * conversation creation and `addParticipant` are unrestricted.
     * Returning a check function gates every (requester, member) edge
     * added by `create("dm" | "group", ...)` and `addParticipant`: both
     * sides must have `owner_user_id` set and the owners must be in
     * contact. Resolved per-call so `app.setContactService(...)` calls
     * made AFTER this service was constructed are visible.
     */
    private resolveContactPolicy: ContactPolicyResolver = () => null,
  ) {}

  /** Write-through: called from MessageService.send() with plaintext parts before encryption */
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
    type: "dm" | "group",
    name: string | undefined,
    agentIds: AgentId[],
    creatorAgentId: AgentId,
    /**
     * Lazy task source. `conversations.task_id` is NOT NULL (round 3
     * R12), so every insert must bind to a task. Issue #464: passing
     * an `Effect` lets the dedup branch short-circuit without minting
     * an orphan task — the Effect runs ONLY on the dedup-miss path.
     * Callers with an existing task id wrap it in `Effect.succeed({
     * id })`; callers that mint a default task pass the
     * `taskService.createDefaultTaskForType(...)` Effect directly.
     */
    mintTask: Effect.Effect<{ id: TaskId }, TaskMintError>,
  ): Effect.Effect<Conversation, ConversationServiceError | TaskMintError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        // Owner-id is read in the same query as the existence check so the
        // contact-policy gate below doesn't issue a second round-trip.
        const agentRows =
          agentIds.length > 0
            ? yield* this.db
                .selectFrom("agents")
                .select(["id", "owner_user_id"])
                .where("id", "in", agentIds)
            : [];
        const ownerByAgentId = new Map<AgentId, string | null>();
        for (const row of agentRows) {
          ownerByAgentId.set(row.id, row.owner_user_id);
        }
        for (const agentId of agentIds) {
          if (!ownerByAgentId.has(agentId)) {
            return yield* Effect.fail(
              new NotFoundError({ message: `Agent ${agentId} not found` }),
            );
          }
        }

        // For DMs, validate exactly one other participant
        if (type === "dm") {
          if (agentIds.length !== 1) {
            return yield* Effect.fail(
              new InvalidParamsError({
                message: "DM requires exactly one other participant",
              }),
            );
          }

          // Check for existing DM between these two agents
          const existingDm = yield* this.findExistingDm(
            creatorAgentId,
            agentIds[0]!,
          );
          if (existingDm) {
            return existingDm;
          }
        }

        // Contact-policy gate (DMs and groups). Only enforced when a
        // policy is wired (production via `WebhookContactService` in
        // standalone.ts; dev/tests default to "no policy = allow all").
        //
        // Pairwise model: every (creator, member) edge in the new
        // conversation must be allowed. The creator is the requester
        // for every edge — group members aren't transitively trusted.
        // A missing `owner_user_id` on either side cannot be evaluated
        // against the policy and is treated as a denial — same
        // fail-closed shape AppHost.checkIdentity uses for app-session
        // admission. Idempotent existing-DM was returned above before
        // we got here, so the policy never re-runs for an established
        // DM (the policy gates CREATION, not access — access is gated
        // by `requireParticipant` on every read/write).
        const policy = this.resolveContactPolicy();
        if (policy && agentIds.length > 0) {
          yield* this.requireCreatorContactsAll(
            creatorAgentId,
            agentIds,
            ownerByAgentId,
            policy,
            type,
          );
        }

        if (type === "group" && agentIds.length + 1 > MAX_GROUP_PARTICIPANTS) {
          return yield* Effect.fail(
            new ConversationFullError({
              message: `Group cannot exceed ${MAX_GROUP_PARTICIPANTS} participants`,
            }),
          );
        }

        // Issue #464: yield the lazy task source ONLY here, after
        // every fail-fast check (agent existence, dm-arity, dedup,
        // contact policy, group cap) has passed. Pre-#464 callers
        // pre-minted unconditionally and orphaned the row whenever
        // a check rejected.
        const task = yield* mintTask;
        const created = yield* transaction(this.db, (trx) =>
          Effect.gen(this, function* () {
            const conv = yield* takeFirstOrFail(
              trx
                .insertInto("conversations")
                .values({
                  type,
                  name: name ?? null,
                  created_by_id: creatorAgentId,
                  task_id: task.id,
                })
                .returningAll(),
            );

            const conversationId = conv.id;

            // Add creator as owner
            yield* trx.insertInto("conversation_participants").values({
              conversation_id: conversationId,
              agent_id: creatorAgentId,
              role: "owner",
            });

            // Add other participants as members
            for (const agentId of agentIds) {
              yield* trx
                .insertInto("conversation_participants")
                .values({
                  conversation_id: conversationId,
                  agent_id: agentId,
                  role: "member",
                })
                .onConflict((oc) => oc.doNothing());
            }

            return this.mapConversation(conv);
          }),
        );

        // Subscribe creator + participants' open sockets to the new
        // conversation. Without this, `network.broadcast({ forConversation })`
        // would skip those sockets (it gates on the per-connection
        // `conversationIds` set) and participants would silently miss every
        // event on this conversation — most notably the `messages/received`
        // events that make up the actual content. Subscribing at the service
        // layer means every caller (RPC handler, downstream app using the
        // service directly) benefits; pre-helper, every consumer had to
        // reimplement this loop and some forgot.
        this.connections.subscribeAgentsToConversation(
          [creatorAgentId, ...agentIds],
          created.id,
        );

        yield* Effect.logInfo("Conversation created").pipe(
          Effect.annotateLogs({
            conversationId: created.id,
            type,
            participantCount: agentIds.length + 1,
          }),
        );

        return created;
      }),
    );
  }

  /**
   * Resolve an `agent:<name>` DM target and ensure a conversation
   * exists. Used by `messages/send` when the caller supplies
   * `to: "agent:<name>"` instead of a known conversationId. The task
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
        return yield* this.create(
          "dm",
          undefined,
          [target.value.id],
          creatorAgentId,
          mintTask,
        );
      }),
    );
  }

  list(
    agentId: AgentId,
    limit = DEFAULT_CONVERSATION_LIST_LIMIT,
    cursor?: string,
    archived: "exclude" | "include" | "only" = "exclude",
  ): Effect.Effect<
    { conversations: ConversationSummary[]; cursor?: string },
    InvalidParamsError
  > {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        let cursorParam: string | null = null;
        if (cursor != null) {
          const parsed = new Date(cursor);
          if (isNaN(parsed.getTime()) || parsed.toISOString() !== cursor) {
            return yield* Effect.fail(
              new InvalidParamsError({
                message: "Cursor must be an ISO-8601 timestamp",
              }),
            );
          }
          cursorParam = cursor;
        }
        const archivedFilter =
          archived === "only"
            ? sql`AND c.archived_at IS NOT NULL`
            : archived === "include"
              ? sql``
              : sql`AND c.archived_at IS NULL`;
        const rows = yield* rawQuery(
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
            WHERE cp.agent_id = ${agentId}
              ${archivedFilter}
              ${cursorParam ? sql`AND c.updated_at < ${cursorParam}` : sql``}
            ORDER BY COALESCE(m.created_at, c.updated_at) DESC
            LIMIT ${limit + 1}
          `,
        );

        const hasMore = rows.length > limit;
        const resultRows = hasMore ? rows.slice(0, limit) : rows;

        const conversations: ConversationSummary[] = resultRows.map((row) => {
          const convId = row.id;
          const cachedPreview = this.previewCache.get(convId);
          return {
            id: convId,
            type: row.type,
            name: row.name ?? undefined,
            lastMessagePreview: cachedPreview,
            lastMessageTimestamp: row.last_message_at
              ? row.last_message_at.toISOString()
              : undefined,
            unreadCount: row.unread_count,
          };
        });

        // Load participant refs for each conversation
        if (conversations.length > 0) {
          const convIds = conversations.map((c) => c.id);
          const partRows = yield* this.db
            .selectFrom("conversation_participants")
            .select(["conversation_id", "agent_id"])
            .where("conversation_id", "in", convIds);

          const partsByConv = new Map<
            ConversationId,
            Array<{ type: "agent"; id: AgentId }>
          >();
          for (const row of partRows) {
            const convId = row.conversation_id;
            if (!partsByConv.has(convId)) partsByConv.set(convId, []);
            partsByConv.get(convId)!.push({
              type: "agent" as const,
              id: row.agent_id,
            });
          }
          for (const conv of conversations) {
            conv.participants = partsByConv.get(conv.id) ?? [];
          }
        }

        return {
          conversations,
          cursor: hasMore
            ? resultRows[resultRows.length - 1]!.updated_at.toISOString()
            : undefined,
        };
      }),
    );
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
        yield* this.requireParticipant(conversationId, requesterAgentId);

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
        const conv = convOpt.value;

        const partRows = yield* this.db
          .selectFrom("conversation_participants as cp")
          .leftJoin("agents as a", "a.id", "cp.agent_id")
          .select([
            "cp.conversation_id",
            "cp.agent_id",
            "cp.role",
            "cp.joined_at",
            "cp.last_read_seq",
            "cp.muted_until",
            "a.name as agent_name",
            "a.display_name as agent_display_name",
          ])
          .where("cp.conversation_id", "=", conversationId);

        return {
          conversation: this.mapConversation(conv),
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
        yield* this.requireRole(conversationId, requesterAgentId, [
          "owner",
          "admin",
        ]);

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
        yield* this.requireRole(conversationId, agentId, ["owner", "admin"]);

        if (this.isAttachedToActiveSession(conversationId)) {
          return yield* Effect.fail(
            new ConflictError({
              message:
                "Conversation is part of an active app session; close the session to archive",
            }),
          );
        }

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
        yield* this.requireRole(conversationId, agentId, ["owner", "admin"]);

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
      Effect.gen(this, function* () {
        yield* this.requireRole(conversationId, requesterAgentId, [
          "owner",
          "admin",
        ]);

        // DMs are immutable two-party records by protocol invariant.
        // Allowing addParticipant on a type='dm' row would silently turn it
        // into a 3-party row that still reports `type='dm'` — every DM-aware
        // consumer downstream (UI, archival, dedupe in `findExistingDm`)
        // assumes exactly two participants and breaks otherwise. Reject
        // before any state change. Symmetric with `leave()` which also
        // rejects DM mutation. Closes #380 §1.
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
            new InvalidParamsError({
              message: "Cannot add participants to a DM conversation",
            }),
          );
        }

        // `requireExists` already returns the new member's owner_user_id,
        // so there's no extra round-trip for the contact-policy gate
        // below.
        const targetOwnerUserId =
          yield* this.participants.requireExists(agentId);

        // Contact-policy gate: an admin/owner cannot use addParticipant
        // to drag an out-of-contact agent into the conversation. Symmetric
        // with `create` — every (requester, member) edge must be allowed.
        // Default behavior preserved when no policy is configured.
        const policy = this.resolveContactPolicy();
        if (policy) {
          const requesterResolved =
            yield* this.participants.resolve(requesterAgentId);
          if (!requesterResolved.exists) {
            return yield* Effect.fail(
              new NotFoundError({
                message: `Agent ${requesterAgentId} not found`,
              }),
            );
          }
          yield* this.checkContactEdge(
            requesterAgentId,
            requesterResolved.ownerUserId,
            agentId,
            targetOwnerUserId,
            policy,
            "addParticipant",
          );
        }

        const countRow = yield* takeFirstOrFail(
          this.db
            .selectFrom("conversation_participants")
            .select(sql<number>`COUNT(*)::int`.as("count"))
            .where("conversation_id", "=", conversationId),
          "count not returned",
        );

        if (countRow.count >= MAX_GROUP_PARTICIPANTS) {
          return yield* Effect.fail(
            new ConversationFullError({
              message: `Group cannot exceed ${MAX_GROUP_PARTICIPANTS} participants`,
            }),
          );
        }

        const row = yield* takeFirstOrFail(
          this.db
            .insertInto("conversation_participants")
            .values({
              conversation_id: conversationId,
              agent_id: agentId,
              role: "member",
            })
            .onConflict((oc) =>
              oc
                .columns(["conversation_id", "agent_id"])
                .doUpdateSet({ role: sql`conversation_participants.role` }),
            )
            .returningAll(),
          "insert did not return row",
        );

        // Subscribe the new participant's open sockets to the conversation.
        // Symmetric with `create`: without this, the conversation broadcast
        // path skips the agent's connections and every event on the
        // conversation silently fails to deliver. The idempotent helper
        // means re-adding an already-subscribed connection is a no-op.
        this.connections.subscribeAgentsToConversation(
          [agentId],
          conversationId,
        );

        return this.mapParticipant(row);
      }),
    );
  }

  removeParticipant(
    conversationId: ConversationId,
    agentId: AgentId,
    requesterAgentId: AgentId,
  ): Effect.Effect<void, ConversationServiceError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        yield* this.requireRole(conversationId, requesterAgentId, [
          "owner",
          "admin",
        ]);

        const deleted = yield* this.db
          .deleteFrom("conversation_participants")
          .where("conversation_id", "=", conversationId)
          .where("agent_id", "=", agentId)
          .where("role", "=", "member")
          .returning("conversation_id");

        if (deleted.length === 0) {
          return yield* Effect.fail(
            new NotFoundError({
              message: "Participant not found or cannot be removed",
            }),
          );
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

  requireParticipant(
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

  private requireRole(
    conversationId: ConversationId,
    agentId: AgentId,
    allowedRoles: string[],
  ): Effect.Effect<void, ForbiddenError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rowOpt = yield* takeFirstOption(
          this.db
            .selectFrom("conversation_participants")
            .select("role")
            .where("conversation_id", "=", conversationId)
            .where("agent_id", "=", agentId),
        );

        if (Option.isNone(rowOpt)) {
          return yield* Effect.fail(
            new ForbiddenError({ message: MSG_NOT_A_PARTICIPANT }),
          );
        }
        if (!allowedRoles.includes(rowOpt.value.role)) {
          return yield* Effect.fail(
            new ForbiddenError({ message: "Insufficient permissions" }),
          );
        }
      }),
    );
  }

  /**
   * Enforce contact policy for every (creator, member) edge in a brand-new
   * conversation. Loads the creator's `owner_user_id` once (the targets'
   * were already read in the existence-check query) and runs the policy
   * pairwise. Both sides of every edge must have an owner; otherwise the
   * conversation is denied with the same `NotInContacts` code the policy
   * itself uses, so callers see one error shape regardless of which
   * precondition failed (matches `AppHost.checkIdentity`'s fail-closed
   * stance for app-session admission).
   *
   * Fail-fast on the first denied edge. Logging includes which path
   * (`dm` | `group`) and the offending edge so operators can trace the
   * decision back to a contact-service response without re-running.
   */
  private requireCreatorContactsAll(
    creatorAgentId: AgentId,
    targetAgentIds: ReadonlyArray<AgentId>,
    ownerByAgentId: ReadonlyMap<AgentId, string | null>,
    policy: ContactPolicyCheck,
    pathLabel: "dm" | "group",
  ): Effect.Effect<void, ConversationServiceError> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const creatorOpt = yield* takeFirstOption(
          this.db
            .selectFrom("agents")
            .select(["owner_user_id"])
            .where("id", "=", creatorAgentId),
        );
        if (Option.isNone(creatorOpt)) {
          return yield* Effect.fail(
            new NotFoundError({ message: `Agent ${creatorAgentId} not found` }),
          );
        }
        const creatorOwner = creatorOpt.value.owner_user_id;
        for (const targetAgentId of targetAgentIds) {
          // The map is built from the existence-check query at the top of
          // `create()` and that loop fails with NotFound for any unknown
          // agentId — so a `Map.get` miss here would be an upstream
          // invariant break, not a missing owner. Surface it as an
          // internal/NotFound rather than masking with `?? null`, which
          // would silently downgrade an invariant break to a denial.
          if (!ownerByAgentId.has(targetAgentId)) {
            return yield* Effect.fail(
              new NotFoundError({
                message: `Agent ${targetAgentId} not found`,
              }),
            );
          }
          const targetOwner = ownerByAgentId.get(targetAgentId) ?? null;
          yield* this.checkContactEdge(
            creatorAgentId,
            creatorOwner,
            targetAgentId,
            targetOwner,
            policy,
            pathLabel,
          );
        }
      }),
    );
  }

  /**
   * Run the contact policy for one (requester, target) edge — used by
   * both new-conversation creation and `addParticipant`. Fail-closed when
   * either side lacks an `owner_user_id`. The denial code is always
   * `NotInContacts` (`-32005`) so clients can branch on a single ErrorCode
   * for "communication not permitted".
   */
  private checkContactEdge(
    requesterAgentId: AgentId,
    requesterOwnerUserId: string | null,
    targetAgentId: AgentId,
    targetOwnerUserId: string | null,
    policy: ContactPolicyCheck,
    pathLabel: "dm" | "group" | "addParticipant",
  ): Effect.Effect<void, ConversationServiceError> {
    return Effect.gen(this, function* () {
      if (!requesterOwnerUserId || !targetOwnerUserId) {
        return yield* Effect.fail(
          new NotInContactsError({
            message: `Contact policy (${pathLabel}) requires both agents to have an owner`,
          }),
        );
      }
      const allowed = yield* policy(requesterOwnerUserId, targetOwnerUserId);
      if (!allowed) {
        yield* Effect.logInfo("Contact policy denied").pipe(
          Effect.annotateLogs({
            pathLabel,
            requesterAgentId,
            targetAgentId,
            requesterOwner: requesterOwnerUserId,
            targetOwner: targetOwnerUserId,
          }),
        );
        return yield* Effect.fail(
          new NotInContactsError({
            message: `Contact policy (${pathLabel}) does not allow this edge`,
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

  private mapParticipant(row: {
    conversation_id: ConversationId;
    agent_id: AgentId;
    role: ParticipantRole;
    joined_at: Date;
    last_read_seq: string;
    muted_until: Date | null;
    agent_name?: string | null;
    agent_display_name?: string | null;
    last_read_message_id?: MessageId | null;
  }): ConversationParticipant {
    return {
      conversationId: row.conversation_id,
      participant: {
        type: "agent" as const,
        id: row.agent_id,
      },
      role: row.role,
      joinedAt: row.joined_at.toISOString(),
      lastReadMessageId:
        row.last_read_message_id == null ? undefined : row.last_read_message_id,
      mutedUntil: row.muted_until ? row.muted_until.toISOString() : undefined,
      agentName: row.agent_name ?? undefined,
      agentDisplayName: row.agent_display_name ?? undefined,
    };
  }
}
