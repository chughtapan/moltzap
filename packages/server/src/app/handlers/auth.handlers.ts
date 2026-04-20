import type { AuthService } from "../../services/auth.service.js";
import type { ConversationService } from "../../services/conversation.service.js";
import type { PresenceService } from "../../services/presence.service.js";
import type { UserService } from "../../services/user.service.js";
import { defineMethod } from "../../rpc/context.js";
import { sql } from "kysely";
import { Effect, Option } from "effect";
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
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
} from "../../db/effect-kysely-toolkit.js";

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
  /** Optional app-minted session resolver. When null, auth/connect rejects
   * `sessionToken` requests with Unauthorized. */
  userService: UserService | null;
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

            const auth: AuthenticatedContext =
              "sessionToken" in params
                ? yield* authenticateSession(
                    params.sessionToken,
                    deps.userService,
                    deps.db,
                  )
                : yield* authenticateAgentKey(
                    params.agentKey,
                    deps.authService,
                  );

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

/** Agent API-key path — existing behavior, typed `never` from authService. */
function authenticateAgentKey(
  agentKey: string,
  authService: AuthService,
): Effect.Effect<AuthenticatedContext, RpcFailure> {
  return Effect.gen(function* () {
    const agent = yield* authService.authenticateAgent(agentKey);
    if (!agent) {
      return yield* Effect.fail(unauthorized("Authentication failed"));
    }
    return {
      agentId: agent.agentId,
      agentStatus: agent.status,
      ownerUserId: agent.ownerUserId,
    };
  });
}

/**
 * App-minted bearer-token path. Resolves the session via
 * `UserService.validateSession`, then looks up the agent status so
 * `requiresActive` gating still works for the bearer path.
 */
function authenticateSession(
  token: string,
  userService: UserService | null,
  db: Db,
): Effect.Effect<AuthenticatedContext, RpcFailure> {
  return catchSqlErrorAsDefect(
    Effect.gen(function* () {
      if (!userService?.validateSession) {
        return yield* Effect.fail(
          unauthorized("Session tokens not supported by this server"),
        );
      }
      const result = yield* userService.validateSession(token);
      if (!result.valid) {
        return yield* Effect.fail(unauthorized("Authentication failed"));
      }
      if (result.agentStatus !== undefined) {
        return {
          agentId: result.agentId,
          agentStatus: result.agentStatus,
          ownerUserId: result.ownerUserId,
        };
      }
      const rowOpt = yield* takeFirstOption(
        db
          .selectFrom("agents")
          .select("status")
          .where("id", "=", result.agentId),
      );
      if (Option.isNone(rowOpt)) {
        return yield* Effect.fail(unauthorized("Authentication failed"));
      }
      return {
        agentId: result.agentId,
        agentStatus: rowOpt.value.status,
        ownerUserId: result.ownerUserId,
      };
    }),
  );
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
