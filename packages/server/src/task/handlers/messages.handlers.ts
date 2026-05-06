import type { MessageService } from "../../services/message.service.js";
import type { ConversationService } from "../../services/conversation.service.js";
import type { TaskService } from "../../services/task.service.js";
import type { RpcMethodRegistry } from "../../rpc/context.js";
import { defineTaskMethod } from "../../rpc/define-layered-method.js";
import {
  MessagesSend,
  MessagesList,
  conversationId as makeConversationId,
} from "@moltzap/protocol";
import { Effect, Option } from "effect";
import { RpcFailure, invalidParams, notFound } from "../../runtime/index.js";
import { ConnIdTag } from "../../app/layers.js";
import type { Db } from "../../db/client.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
} from "../../db/effect-kysely-toolkit.js";

/** Parse "agent:<name>" target format, returning the agent name. */
export function parseTo(to: string): Effect.Effect<string, RpcFailure> {
  const match = to.match(/^agent:(.+)$/);
  if (!match) {
    return Effect.fail(invalidParams("Invalid 'to' format — use agent:<name>"));
  }
  return Effect.succeed(match[1]!);
}

export function createMessageHandlers(deps: {
  messageService: MessageService;
  conversationService: ConversationService;
  taskService: TaskService;
  db: Db;
}): RpcMethodRegistry {
  return [
    defineTaskMethod(MessagesSend, {
      requiresActive: true,
      handler: (params, ctx) =>
        catchSqlErrorAsDefect(
          Effect.gen(function* () {
            let conversationId = params.conversationId;

            if (!conversationId && params.to) {
              const agentName = yield* parseTo(params.to);
              // Phase 9b consumer-migration (sub-issue #460 round 3
              // R14): every conversation belongs to a task; the
              // auto-DM path mints a default-DM-TM-bound task before
              // calling `createDmByAgentName`. If the DM already
              // exists the dedup branch returns the existing
              // conversation and the freshly-minted task is orphaned
              // — pre-prod harmless.
              const task = yield* deps.taskService.createDefaultTaskForType(
                "dm",
                ctx.agentId,
              );
              const conversation =
                yield* deps.conversationService.createDmByAgentName(
                  agentName,
                  ctx.agentId,
                  task.id,
                );
              conversationId = conversation.id;
            }

            if (!conversationId && params.replyToId) {
              const parentOpt = yield* takeFirstOption(
                deps.db
                  .selectFrom("messages")
                  .select(["conversation_id"])
                  .where("id", "=", params.replyToId),
              );
              if (Option.isNone(parentOpt)) {
                return yield* Effect.fail(
                  notFound(
                    `Cannot resolve replyToId ${params.replyToId}: message not found`,
                  ),
                );
              }
              conversationId = makeConversationId(
                parentOpt.value.conversation_id,
              );
            }

            if (!conversationId) {
              return yield* Effect.fail(
                invalidParams(
                  "Either conversationId, to, or replyToId is required",
                ),
              );
            }

            const connId = yield* ConnIdTag;
            // Phase 9b consumer-migration (sub-issue #460): the
            // `dispatchLeaseId` field retired with the
            // `apps/onBeforeMessageDelivery` hook deletion. The protocol
            // schema keeps the optional field (Phase 11 arena cutover
            // retires it on the wire); the server handler stops
            // propagating it.
            const message = yield* deps.messageService.send(
              conversationId,
              params.parts,
              ctx.agentId,
              params.replyToId,
              connId,
            );
            return { message };
          }),
        ),
    }),
    defineTaskMethod(MessagesList, {
      requiresActive: true,
      handler: (params, ctx) =>
        deps.messageService.list(params.conversationId, ctx.agentId, {
          limit: params.limit,
        }),
    }),
  ];
}
