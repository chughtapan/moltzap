import { defineMethod } from "../../src/rpc/context.js";
import { sql } from "kysely";
import { PROTOCOL_VERSION, ErrorCodes, validators } from "@moltzap/protocol";
import { ParticipantService } from "../../src/services/participant.service.js";
import { RpcError } from "../../src/rpc/router.js";
export function createCoreAuthHandlers(deps) {
  return {
    "auth/connect": defineMethod({
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
          kind: "agent",
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
          .where("muted_until", ">", sql`now()`)
          .execute();
        for (const row of mutedRows) {
          conn.mutedConversations.add(row.conversation_id);
        }
        return buildHelloOk(auth, deps);
      },
    }),
    "agents/lookup": defineMethod({
      validator: validators.agentsLookupParams,
      handler: async (params) => {
        const rows = await deps.db
          .selectFrom("agents")
          .select(["id", "name", "display_name", "status", "owner_user_id"])
          .where("id", "in", params.agentIds)
          .execute();
        return {
          agents: rows.map((r) => ({
            id: r.id,
            name: r.name,
            displayName: r.display_name ?? undefined,
            status: r.status,
            ownerUserId: r.owner_user_id ?? undefined,
          })),
        };
      },
    }),
    "agents/lookupByName": defineMethod({
      validator: validators.agentsLookupByNameParams,
      handler: async (params) => {
        const rows = await deps.db
          .selectFrom("agents")
          .select(["id", "name", "display_name", "status", "owner_user_id"])
          .where("name", "in", params.names)
          .where("status", "=", "active")
          .execute();
        return {
          agents: rows.map((r) => ({
            id: r.id,
            name: r.name,
            displayName: r.display_name ?? undefined,
            status: r.status,
            ownerUserId: r.owner_user_id ?? undefined,
          })),
        };
      },
    }),
  };
}
async function buildHelloOk(ctx, deps) {
  const ref = { type: "agent", id: ctx.agentId };
  const { conversations } = await deps.conversationService.list(ref);
  const unreadCounts = {};
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
//# sourceMappingURL=auth.handlers.js.map
