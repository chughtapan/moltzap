import { Effect, Option } from "effect";
import { sql } from "kysely";
import {
  PROTOCOL_VERSION,
  Connect,
  UnauthorizedError,
  type HelloOk,
} from "@moltzap/protocol";
import type {
  AuthenticatedContext,
  RpcMethodRegistry,
} from "../../transport/context.js";
import { defineTaskMethod } from "../../transport/define-layered-method.js";
import {
  AgentEndpointResolverTag,
  AuthServiceTag,
  ConnIdTag,
  ConnectionManagerTag,
  ConversationServiceTag,
  DbTag,
  PresenceServiceTag,
  SessionValidatorTag,
} from "../../app/layers.js";
import { connectionId as brandConnectionId } from "../../network/agent-endpoint-resolver.js";
import type { AuthService } from "../../identity/services/auth.service.js";
import type { PresenceService } from "../../network/services/presence.service.js";
import type { SessionValidator } from "../../identity/services/session-validator.js";
import type { Db } from "../../db/client.js";
import { InvalidParamsError } from "../../runtime/index.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
} from "../../db/effect-kysely-toolkit.js";

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
  presenceService: PresenceService,
): Effect.Effect<HelloOk, UnauthorizedError | InvalidParamsError> {
  return Effect.gen(function* () {
    presenceService.setOnline(ctx.agentId);
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

export const connectHandlers: RpcMethodRegistry = [
  defineTaskMethod(Connect, {
    handler: (params) =>
      catchSqlErrorAsDefect(
        Effect.gen(function* () {
          const authService = yield* AuthServiceTag;
          const conversationService = yield* ConversationServiceTag;
          const presenceService = yield* PresenceServiceTag;
          const connections = yield* ConnectionManagerTag;
          const agentEndpointResolver = yield* AgentEndpointResolverTag;
          const db = yield* DbTag;
          const sessionValidator = yield* SessionValidatorTag;

          const connId = yield* ConnIdTag;
          const conn = connections.get(connId);
          if (!conn) {
            return yield* Effect.fail(
              new UnauthorizedError({ message: "Connection not found" }),
            );
          }

          // If already authenticated, just return the hello payload
          if (conn.auth) {
            return yield* buildHelloOk(conn.auth, presenceService);
          }

          const auth: AuthenticatedContext =
            "sessionToken" in params
              ? yield* authenticateSession(
                  params.sessionToken,
                  sessionValidator,
                  db,
                )
              : yield* authenticateAgentKey(params.agentKey, authService);

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
          const convIds = yield* conversationService.getConversationIds(
            auth.agentId,
          );
          for (const id of convIds) conn.conversationIds.add(id);
          const mutedRows = yield* db
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
          if (connections.get(connId)) {
            yield* agentEndpointResolver.add(
              auth.agentId,
              brandConnectionId(connId),
            );
          }

          return yield* buildHelloOk(auth, presenceService);
        }),
      ),
  }),
];
