import type { Db } from "../db/client.js";
import type { ConversationType, ParticipantRole } from "../db/database.js";
import type { Logger } from "../logger.js";
import type {
  Conversation,
  ConversationParticipant,
  ConversationSummary,
} from "@moltzap/protocol";
import { RpcError } from "../rpc/router.js";
import { ErrorCodes } from "@moltzap/protocol";
import { ParticipantService } from "./participant.service.js";
import { sql } from "kysely";

const MAX_GROUP_PARTICIPANTS = 256;

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
    private logger: Logger,
    private participants: ParticipantService,
  ) {}

  /** Write-through: called from MessageService.send() with plaintext parts before encryption */
  updatePreviewCache(conversationId: string, firstPartText: string): void {
    this.previewCache.set(conversationId, firstPartText.slice(0, 80));
  }

  async create(
    type: "dm" | "group",
    name: string | undefined,
    agentIds: string[],
    creatorAgentId: string,
  ): Promise<Conversation> {
    // Validate all participants exist
    for (const agentId of agentIds) {
      await this.participants.requireExists(agentId);
    }

    // For DMs, validate exactly one other participant
    if (type === "dm") {
      if (agentIds.length !== 1) {
        throw new RpcError(
          ErrorCodes.InvalidParams,
          "DM requires exactly one other participant",
        );
      }

      // Check for existing DM between these two agents
      const existingDm = await this.findExistingDm(
        creatorAgentId,
        agentIds[0]!,
      );
      if (existingDm) {
        return existingDm;
      }
    }

    if (type === "group" && agentIds.length + 1 > MAX_GROUP_PARTICIPANTS) {
      throw new RpcError(
        ErrorCodes.ConversationFull,
        `Group cannot exceed ${MAX_GROUP_PARTICIPANTS} participants`,
      );
    }

    return await this.db.transaction().execute(async (trx) => {
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

      this.logger.info(
        { conversationId, type, participantCount: agentIds.length + 1 },
        "Conversation created",
      );

      return this.mapConversation(conv);
    });
  }

  async list(
    agentId: string,
    limit = 50,
    cursor?: string,
  ): Promise<{ conversations: ConversationSummary[]; cursor?: string }> {
    const cursorParam = cursor ?? null;
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
        ${cursorParam ? sql`AND c.updated_at < ${cursorParam}` : sql``}
      ORDER BY COALESCE(m.created_at, c.updated_at) DESC
      LIMIT ${limit + 1}
    `.execute(this.db);

    const hasMore = result.rows.length > limit;
    const rows = hasMore ? result.rows.slice(0, limit) : result.rows;

    const conversations: ConversationSummary[] = rows.map((row) => {
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
      const partRows = await this.db
        .selectFrom("conversation_participants")
        .select(["conversation_id", "agent_id"])
        .where("conversation_id", "in", convIds)
        .execute();

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
        ? rows[rows.length - 1]!.updated_at.toISOString()
        : undefined,
    };
  }

  async get(
    conversationId: string,
    requesterAgentId: string,
  ): Promise<{
    conversation: Conversation;
    participants: ConversationParticipant[];
  }> {
    await this.requireParticipant(conversationId, requesterAgentId);

    const conv = await this.db
      .selectFrom("conversations")
      .selectAll()
      .where("id", "=", conversationId)
      .executeTakeFirst();

    if (!conv) {
      throw new RpcError(ErrorCodes.NotFound, "Conversation not found");
    }

    const partRows = await this.db
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
      .where("cp.conversation_id", "=", conversationId)
      .execute();

    return {
      conversation: this.mapConversation(conv),
      participants: partRows.map((row) => this.mapParticipant(row)),
    };
  }

  async update(
    conversationId: string,
    name: string | undefined,
    requesterAgentId: string,
  ): Promise<Conversation> {
    await this.requireRole(conversationId, requesterAgentId, [
      "owner",
      "admin",
    ]);

    const row = await this.db
      .updateTable("conversations")
      .set({ name: name ?? null })
      .where("id", "=", conversationId)
      .returningAll()
      .executeTakeFirst();

    if (!row) {
      throw new RpcError(ErrorCodes.NotFound, "Conversation not found");
    }

    return this.mapConversation(row);
  }

  async leave(conversationId: string, agentId: string): Promise<void> {
    const conv = await this.db
      .selectFrom("conversations")
      .select("type")
      .where("id", "=", conversationId)
      .executeTakeFirst();

    if (!conv) {
      throw new RpcError(ErrorCodes.NotFound, "Conversation not found");
    }
    if (conv.type === "dm") {
      throw new RpcError(ErrorCodes.InvalidParams, "Cannot leave a DM");
    }

    const result = await this.db
      .deleteFrom("conversation_participants")
      .where("conversation_id", "=", conversationId)
      .where("agent_id", "=", agentId)
      .executeTakeFirst();

    if (result.numDeletedRows === 0n) {
      throw new RpcError(ErrorCodes.NotFound, "Not a participant");
    }
  }

  async addParticipant(
    conversationId: string,
    agentId: string,
    requesterAgentId: string,
  ): Promise<ConversationParticipant> {
    await this.requireRole(conversationId, requesterAgentId, [
      "owner",
      "admin",
    ]);
    await this.participants.requireExists(agentId);

    const countRow = await this.db
      .selectFrom("conversation_participants")
      .select(sql<number>`COUNT(*)::int`.as("count"))
      .where("conversation_id", "=", conversationId)
      .executeTakeFirstOrThrow();

    if (countRow.count >= MAX_GROUP_PARTICIPANTS) {
      throw new RpcError(
        ErrorCodes.ConversationFull,
        `Group cannot exceed ${MAX_GROUP_PARTICIPANTS} participants`,
      );
    }

    const row = await this.db
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
      .returningAll()
      .executeTakeFirstOrThrow();

    return this.mapParticipant(row);
  }

  async removeParticipant(
    conversationId: string,
    agentId: string,
    requesterAgentId: string,
  ): Promise<void> {
    await this.requireRole(conversationId, requesterAgentId, [
      "owner",
      "admin",
    ]);

    const result = await this.db
      .deleteFrom("conversation_participants")
      .where("conversation_id", "=", conversationId)
      .where("agent_id", "=", agentId)
      .where("role", "=", "member")
      .executeTakeFirst();

    if (result.numDeletedRows === 0n) {
      throw new RpcError(
        ErrorCodes.NotFound,
        "Participant not found or cannot be removed",
      );
    }
  }

  async mute(
    conversationId: string,
    agentId: string,
    until?: string,
  ): Promise<void> {
    const mutedUntil = until ?? "infinity";
    const result = await this.db
      .updateTable("conversation_participants")
      .set({ muted_until: sql`${mutedUntil}::timestamptz` })
      .where("conversation_id", "=", conversationId)
      .where("agent_id", "=", agentId)
      .executeTakeFirst();

    if (!result || result.numUpdatedRows === 0n) {
      throw new RpcError(ErrorCodes.NotFound, "Not a participant");
    }
  }

  async unmute(conversationId: string, agentId: string): Promise<void> {
    const result = await this.db
      .updateTable("conversation_participants")
      .set({ muted_until: null })
      .where("conversation_id", "=", conversationId)
      .where("agent_id", "=", agentId)
      .executeTakeFirst();

    if (!result || result.numUpdatedRows === 0n) {
      throw new RpcError(ErrorCodes.NotFound, "Not a participant");
    }
  }

  async getParticipantAgentIds(conversationId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("conversation_participants")
      .select("agent_id")
      .where("conversation_id", "=", conversationId)
      .execute();

    return rows.map((r) => r.agent_id);
  }

  async getConversationIds(agentId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom("conversation_participants")
      .select("conversation_id")
      .where("agent_id", "=", agentId)
      .execute();

    return rows.map((r) => r.conversation_id);
  }

  async requireParticipant(
    conversationId: string,
    agentId: string,
  ): Promise<void> {
    const row = await this.db
      .selectFrom("conversation_participants")
      .select(sql`1`.as("exists"))
      .where("conversation_id", "=", conversationId)
      .where("agent_id", "=", agentId)
      .executeTakeFirst();

    if (!row) {
      throw new RpcError(
        ErrorCodes.Forbidden,
        "Not a participant in this conversation",
      );
    }
  }

  private async requireRole(
    conversationId: string,
    agentId: string,
    allowedRoles: string[],
  ): Promise<void> {
    const row = await this.db
      .selectFrom("conversation_participants")
      .select("role")
      .where("conversation_id", "=", conversationId)
      .where("agent_id", "=", agentId)
      .executeTakeFirst();

    if (!row) {
      throw new RpcError(ErrorCodes.Forbidden, "Not a participant");
    }
    if (!allowedRoles.includes(row.role)) {
      throw new RpcError(ErrorCodes.Forbidden, "Insufficient permissions");
    }
  }

  private async findExistingDm(
    agentIdA: string,
    agentIdB: string,
  ): Promise<Conversation | null> {
    const result = await sql<ConversationColumns>`
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
    `.execute(this.db);

    if (result.rows.length === 0) return null;
    return this.mapConversation(result.rows[0]!);
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
