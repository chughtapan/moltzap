import type { MessageService } from "../../services/message.service.js";
import type { ConversationService } from "../../services/conversation.service.js";
import type { Db } from "../../db/client.js";
import type { RpcMethodRegistry } from "../../rpc/context.js";
import { defineMethod } from "../../rpc/context.js";
import type { MessagesSendParams, MessagesListParams } from "@moltzap/protocol";
import { validators, ErrorCodes } from "@moltzap/protocol";
import { RpcError } from "../../rpc/router.js";

/** Parse "agent:<name>" target format, returning the agent name. */
export function parseTo(to: string): string {
  const match = to.match(/^agent:(.+)$/);
  if (!match) {
    throw new RpcError(
      ErrorCodes.InvalidParams,
      "Invalid 'to' format — use agent:<name>",
    );
  }
  return match[1]!;
}

export function createMessageHandlers(deps: {
  messageService: MessageService;
  conversationService: ConversationService;
  db: Db;
  getConnId: () => string;
}): RpcMethodRegistry {
  return {
    "messages/send": defineMethod<MessagesSendParams>({
      validator: validators.messagesSendParams,
      requiresActive: true,
      handler: async (params, ctx) => {
        let conversationId = params.conversationId;

        // Resolve `to` field to a conversation
        if (!conversationId && params.to) {
          const agentName = parseTo(params.to);
          // Resolve agent name -> agent ID
          const targetAgent = await deps.db
            .selectFrom("agents")
            .select(["id"])
            .where("name", "=", agentName)
            .where("status", "=", "active")
            .executeTakeFirst();
          if (!targetAgent) {
            throw new RpcError(
              ErrorCodes.NotFound,
              `Agent '${agentName}' not found`,
            );
          }
          // Find or create DM conversation
          const conversation = await deps.conversationService.create(
            "dm",
            undefined,
            [targetAgent.id],
            ctx.agentId,
          );
          conversationId = conversation.id;
        }

        // Resolve replyToId → conversation when conversationId is absent.
        // Replies land in the same conversation as the message being replied to.
        if (!conversationId && params.replyToId) {
          const parent = await deps.db
            .selectFrom("messages")
            .select(["conversation_id"])
            .where("id", "=", params.replyToId)
            .executeTakeFirst();
          if (!parent) {
            throw new RpcError(
              ErrorCodes.NotFound,
              `Cannot resolve replyToId ${params.replyToId}: message not found`,
            );
          }
          conversationId = parent.conversation_id;
        }

        if (!conversationId) {
          throw new RpcError(
            ErrorCodes.InvalidParams,
            "Either conversationId, to, or replyToId is required",
          );
        }

        const message = await deps.messageService.send(
          conversationId,
          params.parts,
          ctx.agentId,
          params.replyToId,
          deps.getConnId(),
        );
        return { message };
      },
    }),

    "messages/list": defineMethod<MessagesListParams>({
      validator: validators.messagesListParams,
      requiresActive: true,
      handler: async (params, ctx) => {
        return deps.messageService.list(params.conversationId, ctx.agentId, {
          limit: params.limit,
        });
      },
    }),
  };
}
