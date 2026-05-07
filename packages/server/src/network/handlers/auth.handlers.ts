import type { AuthService } from "../../services/auth.service.js";
import type { ConversationService } from "../../services/conversation.service.js";
import type { PresenceService } from "../../services/presence.service.js";
import type { SessionValidator } from "../../services/session-validator.js";
import { defineNetworkMethod } from "../../rpc/define-layered-method.js";
import { sql } from "kysely";
import { Effect, Option } from "effect";
import { ConnIdTag } from "../../app/layers.js";
import type {
  RpcMethodRegistry,
  AuthenticatedContext,
} from "../../rpc/context.js";
import type { HelloOk, AgentCard } from "@moltzap/protocol";
import type { ConnectionManager } from "../../ws/connection.js";
import type { Db } from "../../db/client.js";
import type { AgentEndpointResolver } from "../agent-endpoint-resolver.js";
import { connectionId as brandConnectionId } from "../agent-endpoint-resolver.js";
import {
  PROTOCOL_VERSION,
  Connect,
  AgentsLookup,
  AgentsLookupByName,
  AgentsList,
  UnauthorizedError,
} from "@moltzap/protocol";
import type { AgentId, UserId } from "@moltzap/protocol/identity";
import type { AgentId as ServerAgentId } from "../../app/types.js";
import { InvalidParamsError } from "../../runtime/index.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
} from "../../db/effect-kysely-toolkit.js";

function toAgentCard(row: {
  id: AgentId;
  name: string;
  display_name: string | null;
  description: string | null;
  status: string;
  owner_user_id: UserId | null;
}): AgentCard {
  return {
    id: row.id,
    name: row.name,
    displayName: row.display_name ?? undefined,
    description: row.description ?? undefined,
    status: row.status as AgentCard["status"],
    ownerUserId: row.owner_user_id === null ? undefined : row.owner_user_id,
  };
}

export function createCoreAuthHandlers(deps: {
  authService: AuthService;
  conversationService: ConversationService;
  presenceService: PresenceService;
  connections: ConnectionManager;
  /**
   * Slice G1 multimap of `AgentId → HashSet<ConnectionId>`. Populated on
   * successful `network/connect` (this handler), cleared on socket close
   * (the WS finalizer in `app/server.ts`). The new `network.send`
   * outbound primitive routes through this resolver — see
   * `network/network-send.ts` and plan §2.10/§2.11. Phase 9b consumer-
   * migration (sub-issue #460 amendment) collapsed the volatile
   * `agent-conn` `EndpointAddress` wrapping into raw `ConnectionId`
   * lookups; resolver mutators consume `ConnectionId` directly.
   */
  agentEndpointResolver: AgentEndpointResolver;
  db: Db;
  /** Optional bearer-token session validator. When null, `network/connect`
   * rejects `sessionToken` requests with Unauthorized. */
  sessionValidator: SessionValidator | null;
}): RpcMethodRegistry {
  return [
    defineNetworkMethod(Connect, {
      handler: (params) =>
        catchSqlErrorAsDefect(
          Effect.gen(function* () {
            const connId = yield* ConnIdTag;
            const conn = deps.connections.get(connId);
            if (!conn) {
              return yield* Effect.fail(
                new UnauthorizedError({ message: "Connection not found" }),
              );
            }

            // If already authenticated, just return the hello payload
            if (conn.auth) {
              return yield* buildHelloOk(conn.auth, deps);
            }

            const auth: AuthenticatedContext =
              "sessionToken" in params
                ? yield* authenticateSession(
                    params.sessionToken,
                    deps.sessionValidator,
                    deps.db,
                  )
                : yield* authenticateAgentKey(
                    params.agentKey,
                    deps.authService,
                  );

            conn.auth = auth;

            // Phase 8 codex deferral on PR #458 (folded into Phase 9 #427
            // acceptance): defer the resolver registration to AFTER all
            // fallible setup completes, then re-check that the connection
            // is still present in the manager before adding. Two failure
            // modes the deferral closes:
            //
            // (a) Auth-handler failure between `conn.auth = auth` and the
            //     resolver.add (e.g., the conversation/muted-row queries
            //     below): pre-Phase-9 the resolver entry was already
            //     written before those queries fired. A query failure
            //     left the entry in place even though the request as a
            //     whole returned an error. Now the resolver.add only
            //     fires after the queries succeed — partial-failure
            //     auths leave the resolver clean.
            //
            // (b) Close-during-auth race: the WS scope's onExit
            //     finalizer in `app/server.ts` calls `resolver.remove`
            //     when `conn.auth` is set, regardless of whether the
            //     resolver actually holds the entry. If the close lands
            //     between resolver.add and the next observation, the
            //     remove is idempotent (resolver.remove is a no-op on
            //     never-added pairs). The re-check against
            //     `connections.get(connId)` immediately before resolver.add
            //     means a close that fires before the add is observed as
            //     "connection no longer present" and we skip the add
            //     entirely. The finalizer will still fire `remove`
            //     (never-added → no-op).
            //
            // The disconnect finalizer in `app/server.ts:622` mirrors
            // this with `agentEndpointResolver.remove`. `remove` is
            // idempotent on never-added pairs (regression-tested at
            // `agent-endpoint-resolver.test.ts > remove: idempotent on
            // never-added pairs`).
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

            // Re-check the connection is still in the manager before
            // taking the resolver entry. Closes the close-during-auth
            // race named above. The check is cheap (HashMap lookup) and
            // the alternative is a stale entry that the disconnect
            // finalizer would later have to remove via the idempotent
            // `remove` path anyway — making the pre-check explicit
            // documents the invariant. JS-level re-check is sufficient
            // because Effect's interpreter does not preempt between the
            // synchronous `connections.get(connId)` check and the inner
            // `Ref.update` lambda body — both run in the same JS turn,
            // with no `yield*` between.
            if (deps.connections.get(connId)) {
              yield* deps.agentEndpointResolver.add(
                auth.agentId,
                brandConnectionId(connId),
              );
            }

            return yield* buildHelloOk(auth, deps);
          }),
        ),
    }),

    defineNetworkMethod(AgentsLookup, {
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
              .where("id", "in", params.agentIds as ServerAgentId[]);
            return { agents: rows.map(toAgentCard) };
          }),
        ),
    }),
    defineNetworkMethod(AgentsLookupByName, {
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
    defineNetworkMethod(AgentsList, {
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
  ];
}

/** Agent API-key path — existing behavior, typed `never` from authService. */
function authenticateAgentKey(
  agentKey: string,
  authService: AuthService,
): Effect.Effect<AuthenticatedContext, UnauthorizedError> {
  return Effect.gen(function* () {
    const agent = yield* authService.authenticateAgent(agentKey);
    if (!agent) {
      return yield* Effect.fail(
        new UnauthorizedError({ message: "Authentication failed" }),
      );
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
 * `SessionValidator.validateSession`, then looks up the agent status so
 * `requiresActive` gating still works for the bearer path.
 */
function authenticateSession(
  token: string,
  sessionValidator: SessionValidator | null,
  db: Db,
): Effect.Effect<AuthenticatedContext, UnauthorizedError> {
  return catchSqlErrorAsDefect(
    Effect.gen(function* () {
      if (!sessionValidator) {
        return yield* Effect.fail(
          new UnauthorizedError({
            message: "Session tokens not supported by this server",
          }),
        );
      }
      const result = yield* sessionValidator.validateSession(token);
      if (!result.valid) {
        return yield* Effect.fail(
          new UnauthorizedError({ message: "Authentication failed" }),
        );
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
        return yield* Effect.fail(
          new UnauthorizedError({ message: "Authentication failed" }),
        );
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
    presenceService: PresenceService;
  },
): Effect.Effect<HelloOk, UnauthorizedError | InvalidParamsError> {
  return Effect.gen(function* () {
    deps.presenceService.setOnline(ctx.agentId);
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentId: ctx.agentId,
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
