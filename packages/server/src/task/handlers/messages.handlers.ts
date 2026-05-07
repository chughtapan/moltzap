import type { MessageService } from "../../services/message.service.js";
import type { ConversationService } from "../../services/conversation.service.js";
import type { TaskService } from "../../services/task.service.js";
import type { RpcMethodRegistry } from "../../rpc/context.js";
import { defineTaskMethod } from "../../rpc/define-layered-method.js";
import { MessagesSend, MessagesList, NotFoundError } from "@moltzap/protocol";
import { Effect, Option } from "effect";
import { InvalidParamsError } from "../../runtime/index.js";
import { ConnIdTag } from "../../app/layers.js";
import type { Db } from "../../db/client.js";
import {
  catchSqlErrorAsDefect,
  takeFirstOption,
} from "../../db/effect-kysely-toolkit.js";

/** Parse "agent:<name>" target format, returning the agent name. */
export function parseTo(to: string): Effect.Effect<string, InvalidParamsError> {
  const match = to.match(/^agent:(.+)$/);
  if (!match) {
    return Effect.fail(
      new InvalidParamsError({
        message: "Invalid 'to' format — use agent:<name>",
      }),
    );
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
              // Issue #464: lazy `mintTask` so dedup hits don't
              // orphan a default-DM task.
              const conversation =
                yield* deps.conversationService.createDmByAgentName(
                  agentName,
                  ctx.agentId,
                  deps.taskService.createDefaultTaskForType("dm", ctx.agentId),
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
                  new NotFoundError({
                    message: `Cannot resolve replyToId ${params.replyToId}: message not found`,
                  }),
                );
              }
              conversationId = parentOpt.value.conversation_id;
            }

            if (!conversationId) {
              return yield* Effect.fail(
                new InvalidParamsError({
                  message:
                    "Either conversationId, to, or replyToId is required",
                }),
              );
            }

            const connId = yield* ConnIdTag;
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
