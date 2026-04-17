import type { AuthService } from "../../services/auth.service.js";
import type { ConversationService } from "../../services/conversation.service.js";
import type { PresenceService } from "../../services/presence.service.js";
import { defineMethod } from "../../rpc/context.js";
import { sql } from "kysely";
import { Effect } from "effect";
import { ConnIdTag } from "../layers.js";
import type {
  RpcMethodRegistry,
  AuthenticatedContext,
} from "../../rpc/context.js";
import type { HelloOk, AgentCard } from "@moltzap/protocol";
import type { ConnectionManager } from "../../ws/connection.js";
import type { Db } from "../../db/client.js";
import {
  PROTOCOL_VERSION,
  Connect,
  AgentsLookup,
  AgentsLookupByName,
  AgentsList,
} from "@moltzap/protocol";
import type { RpcFailure } from "../../runtime/index.js";
import { unauthorized } from "../../runtime/index.js";
import { catchSqlErrorAsDefect } from "../../db/effect-kysely-toolkit.js";

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
}): RpcMethodRegistry {
  return {
    "auth/connect": defineMethod(Connect, {
      handler: (params) =>
        catchSqlErrorAsDefect(
          Effect.gen(function* () {
            const connId = yield* ConnIdTag;
            const conn = deps.connections.get(connId);
            if (!conn) {
              return yield* Effect.fail(unauthorized("Connection not found"));
            }

            // If already authenticated, just return the hello payload
            if (conn.auth) {
              return yield* buildHelloOk(conn.auth, deps);
            }

            const agent = yield* deps.authService.authenticateAgent(
              params.agentKey,
            );
            if (!agent) {
              return yield* Effect.fail(unauthorized("Authentication failed"));
            }

            const auth: AuthenticatedContext = {
              agentId: agent.agentId,
              agentStatus: agent.status,
              ownerUserId: agent.ownerUserId,
            };

            conn.auth = auth;

            const convIds = yield* deps.conversationService.getConversationIds(
              auth.agentId,
            );
            for (const id of convIds) conn.conversationIds.add(id);
            const mutedRows = yield* deps.db
              .selectFrom("conversation_participants")
              .select("conversation_id")
              .where("agent_id", "=", auth.agentId)
              .where("muted_until", "is not", null)
              .where("muted_until", ">", sql<Date>`now()`);
            for (const row of mutedRows) {
              conn.mutedConversations.add(row.conversation_id);
            }

            return yield* buildHelloOk(auth, deps);
          }),
        ),
    }),

    // Key must match the manifest's `name` field so the dispatcher resolves
    // it correctly; `AgentsLookup.name === "agents/lookup"`.
    [AgentsLookup.name]: defineMethod(AgentsLookup, {
      handler: (params) =>
        catchSqlErrorAsDefect(
          Effect.gen(function* () {
            const rows = yield* deps.db
              .selectFrom("agents")
              .select([
                "id",
                "name",
                "display_name",
                "description",
                "status",
                "owner_user_id",
              ])
              .where("id", "in", params.agentIds);
            return { agents: rows.map(toAgentCard) };
          }),
        ),
    }),

    [AgentsLookupByName.name]: defineMethod(AgentsLookupByName, {
      handler: (params) =>
        catchSqlErrorAsDefect(
          Effect.gen(function* () {
            const rows = yield* deps.db
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
              .where("status", "=", "active");
            return { agents: rows.map(toAgentCard) };
          }),
        ),
    }),

    "agents/list": defineMethod(AgentsList, {
      requiresActive: true,
      handler: (_params, ctx) =>
        catchSqlErrorAsDefect(
          Effect.gen(function* () {
            const rows = yield* deps.db
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
              .distinct();

            const agents: Record<string, AgentCard> = {};
            for (const row of rows) {
              agents[row.id] = toAgentCard(row);
            }
            return { agents };
          }),
        ),
    }),
  };
}

function buildHelloOk(
  ctx: AuthenticatedContext,
  deps: {
    conversationService: ConversationService;
    presenceService: PresenceService;
  },
): Effect.Effect<HelloOk, RpcFailure> {
  return Effect.gen(function* () {
    const { conversations } = yield* deps.conversationService.list(ctx.agentId);

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
  });
}
