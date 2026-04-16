import type { AuthService } from "../../services/auth.service.js";
import type { ConversationService } from "../../services/conversation.service.js";
import type { PresenceService } from "../../services/presence.service.js";
import type { UserService } from "../../services/user.service.js";
import { defineMethod } from "../../rpc/context.js";
import { sql } from "kysely";
import type {
  RpcMethodRegistry,
  AuthenticatedContext,
} from "../../rpc/context.js";
import type {
  HelloOk,
  ConnectParams,
  AgentsLookupParams,
  AgentsLookupByNameParams,
  AgentsListParams,
  AgentCard,
} from "@moltzap/protocol";
import type { ConnectionManager } from "../../ws/connection.js";
import type { Db } from "../../db/client.js";
import { PROTOCOL_VERSION, ErrorCodes, validators } from "@moltzap/protocol";
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
  connections: ConnectionManager;
  db: Db;
  getConnId: () => string;
  /** Accessor for the live UserService (set via core.setUserService). Used
   * to resolve `sessionToken` bearer auth during auth/connect. */
  getUserService: () => UserService | null;
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
          return buildHelloOk(conn.auth, deps);
        }

        let auth: AuthenticatedContext;

        if (params.sessionToken && !params.agentKey) {
          // Bearer-token path: delegate to UserService.validateSession
          const userSvc = deps.getUserService();
          if (!userSvc?.validateSession) {
            throw new RpcError(
              ErrorCodes.Unauthorized,
              "Session tokens not supported by this server",
            );
          }
          const result = await userSvc.validateSession(params.sessionToken);
          if (!result.valid || !result.agentId || !result.ownerUserId) {
            throw new RpcError(
              ErrorCodes.Unauthorized,
              "Authentication failed",
            );
          }
          // Look up agent status so `requiresActive` gating still works.
          const row = await deps.db
            .selectFrom("agents")
            .select("status")
            .where("id", "=", result.agentId)
            .executeTakeFirst();
          if (!row) {
            throw new RpcError(
              ErrorCodes.Unauthorized,
              "Authentication failed",
            );
          }
          auth = {
            agentId: result.agentId,
            agentStatus: row.status,
            ownerUserId: result.ownerUserId,
          };
        } else if (params.agentKey && !params.sessionToken) {
          // Agent API key path (unchanged)
          const agent = await deps.authService.authenticateAgent(
            params.agentKey,
          );
          if (!agent) {
            throw new RpcError(
              ErrorCodes.Unauthorized,
              "Authentication failed",
            );
          }
          auth = {
            agentId: agent.agentId,
            agentStatus: agent.status,
            ownerUserId: agent.ownerUserId,
          };
        } else {
          throw new RpcError(
            ErrorCodes.InvalidParams,
            "Exactly one of `agentKey` or `sessionToken` required",
          );
        }

        // Set auth on the connection
        conn.auth = auth;

        // Subscribe to conversation channels and load muted set
        const convIds = await deps.conversationService.getConversationIds(
          auth.agentId,
        );
        for (const id of convIds) conn.conversationIds.add(id);
        const mutedRows = await deps.db
          .selectFrom("conversation_participants")
          .select("conversation_id")
          .where("agent_id", "=", auth.agentId)
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
        const rows = await deps.db
          .selectFrom("conversation_participants as cp")
          .innerJoin("agents as a", "a.id", "cp.agent_id")
          .select([
            "a.id",
            "a.name",
            "a.display_name",
            "a.description",
            "a.status",
            "a.owner_user_id",
          ])
          .where("cp.agent_id", "!=", ctx.agentId)
          .where((eb) =>
            eb.exists(
              eb
                .selectFrom("conversation_participants as cp2")
                .select("cp2.conversation_id")
                .whereRef("cp2.conversation_id", "=", "cp.conversation_id")
                .where("cp2.agent_id", "=", ctx.agentId),
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
  ctx: AuthenticatedContext,
  deps: {
    conversationService: ConversationService;
    presenceService: PresenceService;
  },
): Promise<HelloOk> {
  const { conversations } = await deps.conversationService.list(ctx.agentId);

  const unreadCounts: Record<string, number> = {};
  for (const conv of conversations) {
    if (conv.unreadCount > 0) {
      unreadCounts[conv.id] = conv.unreadCount;
    }
  }

  deps.presenceService.setOnline(ctx.agentId);

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
