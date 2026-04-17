import type { Db } from "../db/client.js";
import type { ConversationType, ParticipantRole } from "../db/database.js";
import type {
  Conversation,
  ConversationParticipant,
  ConversationSummary,
} from "@moltzap/protocol";
import { Effect, Option } from "effect";
import {
  RpcFailure,
  notFound,
  forbidden,
  invalidParams,
} from "../runtime/index.js";
import { ErrorCodes } from "@moltzap/protocol";
import { ParticipantService } from "./participant.service.js";
import { sql } from "kysely";
import {
  catchSqlErrorAsDefect,
  rawQuery,
  takeFirstOption,
  takeFirstOrFail,
  transaction,
} from "../db/effect-kysely-toolkit.js";

const MAX_GROUP_PARTICIPANTS = 256;
const PREVIEW_CACHE_MAX = 2000;

interface ListRow {
  id: string;
  type: ConversationType;
  name: string | null;
  updated_at: Date;
  has_last_message: boolean;
  last_message_at: Date | null;
  unread_count: number;
}

interface ConversationColumns {
  id: string;
  type: ConversationType;
  name: string | null;
  created_by_id: string;
  created_at: Date;
  updated_at: Date;
}

export class ConversationService {
  /** In-memory cache for last message previews — avoids decrypting on every list() call */
  private previewCache = new Map<string, string>();

  constructor(
    private db: Db,
    private participants: ParticipantService,
  ) {}

  /** Write-through: called from MessageService.send() with plaintext parts before encryption */
  updatePreviewCache(conversationId: string, firstPartText: string): void {
    this.previewCache.delete(conversationId);
    this.previewCache.set(conversationId, firstPartText.slice(0, 80));
    if (this.previewCache.size > PREVIEW_CACHE_MAX) {
      const oldest = this.previewCache.keys().next().value!;
      this.previewCache.delete(oldest);
    }
  }

  create(
    type: "dm" | "group",
    name: string | undefined,
    agentIds: string[],
    creatorAgentId: string,
  ): Effect.Effect<Conversation, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        if (agentIds.length > 0) {
          const found = yield* this.db
            .selectFrom("agents")
            .select("id")
            .where("id", "in", agentIds);
          const foundIds = new Set(found.map((r) => r.id));
          for (const agentId of agentIds) {
            if (!foundIds.has(agentId)) {
              return yield* Effect.fail(notFound(`Agent ${agentId} not found`));
            }
          }
        }

        // For DMs, validate exactly one other participant
        if (type === "dm") {
          if (agentIds.length !== 1) {
            return yield* Effect.fail(
              invalidParams("DM requires exactly one other participant"),
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

        if (type === "group" && agentIds.length + 1 > MAX_GROUP_PARTICIPANTS) {
          return yield* Effect.fail(
            new RpcFailure({
              code: ErrorCodes.ConversationFull,
              message: `Group cannot exceed ${MAX_GROUP_PARTICIPANTS} participants`,
            }),
          );
        }

        // #ignore-sloppy-code-next-line[async-keyword]: Kysely transaction callback contract
        const created = yield* transaction(this.db, async (trx) => {
          const conv = await trx
            .insertInto("conversations")
            .values({
              type,
              name: name ?? null,
              created_by_id: creatorAgentId,
            })
            .returningAll()
            .executeTakeFirstOrThrow();

          const conversationId = conv.id;

          // Add creator as owner
          await trx
            .insertInto("conversation_participants")
            .values({
              conversation_id: conversationId,
              agent_id: creatorAgentId,
              role: "owner",
            })
            .execute();

          // Add other participants as members
          for (const agentId of agentIds) {
            await trx
              .insertInto("conversation_participants")
              .values({
                conversation_id: conversationId,
                agent_id: agentId,
                role: "member",
              })
              .onConflict((oc) => oc.doNothing())
              .execute();
          }

          return this.mapConversation(conv);
        });

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
   * Resolve an `agent:<name>` DM target and ensure a conversation exists.
   * Used by `messages/send` when the caller supplies `to: "agent:<name>"`
   * instead of a known conversationId.
   */
  createDmByAgentName(
    agentName: string,
    creatorAgentId: string,
  ): Effect.Effect<Conversation, RpcFailure> {
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
          return yield* Effect.fail(notFound(`Agent '${agentName}' not found`));
        }
        return yield* this.create(
          "dm",
          undefined,
          [target.value.id],
          creatorAgentId,
        );
      }),
    );
  }

  list(
    agentId: string,
    limit = 50,
    cursor?: string,
  ): Effect.Effect<
    { conversations: ConversationSummary[]; cursor?: string },
    RpcFailure
  > {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const cursorParam = cursor ?? null;
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
              AND c.archived_at IS NULL
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
            string,
            Array<{ type: "agent"; id: string }>
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
    conversationId: string,
    requesterAgentId: string,
  ): Effect.Effect<
    {
      conversation: Conversation;
      participants: ConversationParticipant[];
    },
    RpcFailure
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
          return yield* Effect.fail(notFound("Conversation not found"));
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
    conversationId: string,
    name: string | undefined,
    requesterAgentId: string,
  ): Effect.Effect<Conversation, RpcFailure> {
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
          return yield* Effect.fail(notFound("Conversation not found"));
        }

        return this.mapConversation(rowOpt.value);
      }),
    );
  }

  leave(
    conversationId: string,
    agentId: string,
  ): Effect.Effect<void, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const convOpt = yield* takeFirstOption(
          this.db
            .selectFrom("conversations")
            .select("type")
            .where("id", "=", conversationId),
        );

        if (Option.isNone(convOpt)) {
          return yield* Effect.fail(notFound("Conversation not found"));
        }
        if (convOpt.value.type === "dm") {
          return yield* Effect.fail(invalidParams("Cannot leave a DM"));
        }

        const deleted = yield* this.db
          .deleteFrom("conversation_participants")
          .where("conversation_id", "=", conversationId)
          .where("agent_id", "=", agentId)
          .returning("conversation_id");

        if (deleted.length === 0) {
          return yield* Effect.fail(notFound("Not a participant"));
        }
      }),
    );
  }

  addParticipant(
    conversationId: string,
    agentId: string,
    requesterAgentId: string,
  ): Effect.Effect<ConversationParticipant, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        yield* this.requireRole(conversationId, requesterAgentId, [
          "owner",
          "admin",
        ]);
        yield* this.participants.requireExists(agentId);

        const countRow = yield* takeFirstOrFail(
          this.db
            .selectFrom("conversation_participants")
            .select(sql<number>`COUNT(*)::int`.as("count"))
            .where("conversation_id", "=", conversationId),
          "count not returned",
        );

        if (countRow.count >= MAX_GROUP_PARTICIPANTS) {
          return yield* Effect.fail(
            new RpcFailure({
              code: ErrorCodes.ConversationFull,
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

        return this.mapParticipant(row);
      }),
    );
  }

  removeParticipant(
    conversationId: string,
    agentId: string,
    requesterAgentId: string,
  ): Effect.Effect<void, RpcFailure> {
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
            notFound("Participant not found or cannot be removed"),
          );
        }
      }),
    );
  }

  // PGlite's Kysely dialect returns numUpdatedRows: 0n on UPDATE even when rows match.
  // Use .returning().execute() and check rows.length instead.
  mute(
    conversationId: string,
    agentId: string,
    until?: string,
  ): Effect.Effect<void, RpcFailure> {
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
          return yield* Effect.fail(notFound("Not a participant"));
        }
      }),
    );
  }

  unmute(
    conversationId: string,
    agentId: string,
  ): Effect.Effect<void, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rows = yield* this.db
          .updateTable("conversation_participants")
          .set({ muted_until: sql.lit(null) })
          .where("conversation_id", "=", conversationId)
          .where("agent_id", "=", agentId)
          .returning("conversation_id");

        if (rows.length === 0) {
          return yield* Effect.fail(notFound("Not a participant"));
        }
      }),
    );
  }

  getParticipantAgentIds(
    conversationId: string,
  ): Effect.Effect<string[], RpcFailure> {
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

  getConversationIds(agentId: string): Effect.Effect<string[], RpcFailure> {
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
    conversationId: string,
    agentId: string,
  ): Effect.Effect<void, RpcFailure> {
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
            forbidden("Not a participant in this conversation"),
          );
        }
      }),
    );
  }

  private requireRole(
    conversationId: string,
    agentId: string,
    allowedRoles: string[],
  ): Effect.Effect<void, RpcFailure> {
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
          return yield* Effect.fail(forbidden("Not a participant"));
        }
        if (!allowedRoles.includes(rowOpt.value.role)) {
          return yield* Effect.fail(forbidden("Insufficient permissions"));
        }
      }),
    );
  }

  private findExistingDm(
    agentIdA: string,
    agentIdB: string,
  ): Effect.Effect<Conversation | null, RpcFailure> {
    return catchSqlErrorAsDefect(
      Effect.gen(this, function* () {
        const rows = yield* rawQuery(
          this.db,
          sql<ConversationColumns>`
            SELECT c.* FROM conversations c
            WHERE c.type = 'dm'
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
    conversation_id: string;
    agent_id: string;
    role: ParticipantRole;
    joined_at: Date;
    last_read_seq: string;
    muted_until: Date | null;
    agent_name?: string | null;
    agent_display_name?: string | null;
    last_read_message_id?: string | null;
  }): ConversationParticipant {
    return {
      conversationId: row.conversation_id,
      participant: {
        type: "agent" as const,
        id: row.agent_id,
      },
      role: row.role,
      joinedAt: row.joined_at.toISOString(),
      lastReadMessageId: row.last_read_message_id ?? undefined,
      mutedUntil: row.muted_until ? row.muted_until.toISOString() : undefined,
      agentName: row.agent_name ?? undefined,
      agentDisplayName: row.agent_display_name ?? undefined,
    };
  }
}
