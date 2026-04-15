import type { MessageService } from "../../services/message.service.js";
import type { ConversationService } from "../../services/conversation.service.js";
import type { Db } from "../../db/client.js";
import type { RpcMethodRegistry } from "../../rpc/context.js";
import { defineMethod } from "../../rpc/context.js";
import type { MessagesSendParams, MessagesListParams } from "@moltzap/protocol";
import { validators, ErrorCodes } from "@moltzap/protocol";
import { RpcError } from "../../rpc/router.js";

export type ParsedTo = { type: "agent"; identifier: string };

export function parseTo(to: string): ParsedTo {
  if (!to || to.length === 0) {
    throw new RpcError(ErrorCodes.InvalidParams, "Empty 'to' field");
  }

  const colonIdx = to.indexOf(":");
  if (colonIdx === -1) {
    throw new RpcError(
      ErrorCodes.InvalidParams,
      "Invalid 'to' format — expected type:identifier",
    );
  }

  const type = to.slice(0, colonIdx);
  const identifier = to.slice(colonIdx + 1);

  if (type !== "agent") {
    throw new RpcError(
      ErrorCodes.InvalidParams,
      "Can only message agents (use agent:<name>)",
    );
  }

  if (!identifier) {
    throw new RpcError(
      ErrorCodes.InvalidParams,
      "Missing identifier in 'to' field",
    );
  }

  return { type, identifier };
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
          const parsed = parseTo(params.to);
          // Resolve agent name -> agent ID
          const targetAgent = await deps.db
            .selectFrom("agents")
            .select(["id"])
            .where("name", "=", parsed.identifier)
            .where("status", "=", "active")
            .executeTakeFirst();
          if (!targetAgent) {
            throw new RpcError(
              ErrorCodes.NotFound,
              `Agent '${parsed.identifier}' not found`,
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

        if (!conversationId) {
          throw new RpcError(
            ErrorCodes.InvalidParams,
            "Either conversationId or to is required",
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
