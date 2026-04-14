import type { AuthService } from "../../services/auth.service.js";
import type { ConversationService } from "../../services/conversation.service.js";
import type { PresenceService } from "../../services/presence.service.js";
import { defineMethod } from "../../rpc/context.js";
import { sql } from "kysely";
import type { RpcMethodRegistry } from "../../rpc/context.js";
import type {
  HelloOk,
  ParticipantRef,
  ConnectParams,
  AgentsLookupParams,
  AgentsLookupByNameParams,
  AgentsListParams,
  AgentCard,
} from "@moltzap/protocol";
import type { ConnectionManager } from "../../ws/connection.js";
import type { Broadcaster } from "../../ws/broadcaster.js";
import type { Db } from "../../db/client.js";
import { PROTOCOL_VERSION, ErrorCodes, validators } from "@moltzap/protocol";
import { ParticipantService } from "../../services/participant.service.js";
import { RpcError } from "../../rpc/router.js";

function toAgentCard(row: {
  id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  status: string;
  owner_user_id: string | null;
}): AgentCard {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name ?? undefined,
    description: row.description ?? undefined,
    status: row.status as AgentCard["status"],
    ownerUserId: row.owner_user_id ?? undefined,
  };
}

export function createCoreAuthHandlers(deps: {
  authService: AuthService;
  conversationService: ConversationService;
  presenceService: PresenceService;
  broadcaster: Broadcaster;
  connections: ConnectionManager;
  db: Db;
  getConnId: () => string;
}): RpcMethodRegistry {
  return {
    "auth/connect": defineMethod<ConnectParams>({
      validator: validators.connectParams,
      handler: async (params, _ctx) => {
        const connId = deps.getConnId();
        const conn = deps.connections.get(connId);
        if (!conn) {
          throw new RpcError(ErrorCodes.Unauthorized, "Connection not found");
        }

        // If already authenticated, just return the hello payload
        if (conn.auth) {
          if (conn.auth.kind !== "agent") {
            throw new RpcError(ErrorCodes.Unauthorized, "Agent key required");
          }
          return buildHelloOk(conn.auth, deps);
        }

        const p = params;

        if (!("agentKey" in p)) {
          throw new RpcError(
            ErrorCodes.Unauthorized,
            "Agent key required for authentication",
          );
        }

        const agent = await deps.authService.authenticateAgent(p.agentKey);
        if (!agent) {
          throw new RpcError(ErrorCodes.Unauthorized, "Authentication failed");
        }

        const auth = {
          kind: "agent" as const,
          agentId: agent.agentId,
          agentStatus: agent.status,
          ownerUserId: agent.ownerUserId,
        };

        // Set auth on the connection
        conn.auth = auth;

        // Subscribe to conversation channels and load muted set
        const ref = ParticipantService.refFromContext(auth);
        const convIds = await deps.conversationService.getConversationIds(ref);
        for (const id of convIds) conn.conversationIds.add(id);
        const mutedRows = await deps.db
          .selectFrom("conversation_participants")
          .select("conversation_id")
          .where("participant_type", "=", ref.type)
          .where("participant_id", "=", ref.id)
          .where("muted_until", "is not", null)
          .where("muted_until", ">", sql<Date>`now()`)
          .execute();
        for (const row of mutedRows) {
          conn.mutedConversations.add(row.conversation_id);
        }

        return buildHelloOk(auth, deps);
      },
    }),

    "agents/lookup": defineMethod<AgentsLookupParams>({
      validator: validators.agentsLookupParams,
      handler: async (params) => {
        const rows = await deps.db
          .selectFrom("agents")
          .select([
            "id",
            "name",
            "display_name",
            "description",
            "status",
            "owner_user_id",
          ])
          .where("id", "in", params.agentIds)
          .execute();
        return { agents: rows.map(toAgentCard) };
      },
    }),

    "agents/lookupByName": defineMethod<AgentsLookupByNameParams>({
      validator: validators.agentsLookupByNameParams,
      handler: async (params) => {
        const rows = await deps.db
          .selectFrom("agents")
          .select([
            "id",
            "name",
            "display_name",
            "description",
            "status",
            "owner_user_id",
          ])
          .where("name", "in", params.names)
          .where("status", "=", "active")
          .execute();
        return { agents: rows.map(toAgentCard) };
      },
    }),

    "agents/list": defineMethod<AgentsListParams>({
      validator: validators.agentsListParams,
      requiresActive: true,
      handler: async (_params, ctx) => {
        if (ctx.kind !== "agent") {
          throw new RpcError(
            ErrorCodes.Forbidden,
            "Agent authentication required",
          );
        }
        const rows = await deps.db
          .selectFrom("conversation_participants as cp")
          .innerJoin("agents as a", "a.id", "cp.participant_id")
          .select([
            "a.id",
            "a.name",
            "a.display_name",
            "a.description",
            "a.status",
            "a.owner_user_id",
          ])
          .where("cp.participant_type", "=", "agent")
          .where("cp.participant_id", "!=", ctx.agentId)
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom("conversation_participants as cp2")
                .select("cp2.conversation_id")
                .whereRef("cp2.conversation_id", "=", "cp.conversation_id")
                .where("cp2.participant_type", "=", "agent")
                .where("cp2.participant_id", "=", ctx.agentId),
            ),
          )
          .distinct()
          .execute();

        const agents: Record<string, AgentCard> = {};
        for (const row of rows) {
          agents[row.id] = toAgentCard(row);
        }
        return { agents };
      },
    }),
  };
}

async function buildHelloOk(
  ctx: {
    kind: "agent";
    agentId: string;
    agentStatus: string;
    ownerUserId: string | null;
  },
  deps: {
    conversationService: ConversationService;
    presenceService: PresenceService;
  },
): Promise<HelloOk> {
  const ref: ParticipantRef = { type: "agent", id: ctx.agentId };

  const { conversations } = await deps.conversationService.list(ref);

  const unreadCounts: Record<string, number> = {};
  for (const conv of conversations) {
    if (conv.unreadCount > 0) {
      unreadCounts[conv.id] = conv.unreadCount;
    }
  }

  deps.presenceService.setOnline(ref);

  return {
    protocolVersion: PROTOCOL_VERSION,
    agentId: ctx.agentId,
    conversations,
    unreadCounts,
    policy: {
      maxMessageBytes: 65536,
      maxPartsPerMessage: 10,
      maxTextLength: 32768,
      maxGroupParticipants: 256,
      heartbeatIntervalMs: 30000,
      rateLimits: {
        messagesPerMinute: 60,
        requestsPerMinute: 120,
      },
    },
  };
}
