import type { MessageService } from "../../src/services/message.service.js";
import type { ConversationService } from "../../src/services/conversation.service.js";
import type { ConnectionManager } from "../../src/ws/connection.js";
import type { Db } from "../../src/db/client.js";
import type { RpcMethodRegistry } from "../../src/rpc/context.js";
import { defineMethod } from "../../src/rpc/context.js";
import type {
  ParticipantRef,
  MessagesSendParams,
  MessagesListParams,
  MessagesReadParams,
  MessagesReactParams,
  MessagesDeleteParams,
} from "@moltzap/protocol";
import { validators, ErrorCodes } from "@moltzap/protocol";
import { ParticipantService } from "../../src/services/participant.service.js";
import { RpcError } from "../../src/rpc/router.js";

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
  connections: ConnectionManager;
  db: Db;
  getConnId: () => string;
}): RpcMethodRegistry {
  return {
    "messages/send": defineMethod<MessagesSendParams>({
      validator: validators.messagesSendParams,
      requiresActive: true,
      handler: async (params, ctx) => {
        let senderRef: ParticipantRef;

        if (ctx.kind === "user") {
          // Humans can only send to their own agent's control channel
          if (!ctx.activeAgentId) {
            throw new RpcError(
              ErrorCodes.Forbidden,
              "No active agent. Claim an agent first.",
            );
          }
          if (!params.conversationId) {
            throw new RpcError(
              ErrorCodes.Forbidden,
              "Humans can only send to the control channel via conversationId.",
            );
          }

          // Check cached control channel first, fall back to DB query
          const conn = deps.connections.get(deps.getConnId());
          let isControl = conn?.controlChannelId === params.conversationId;
          if (!isControl) {
            isControl = await deps.conversationService.isControlChannel(
              params.conversationId,
              ctx.userId,
              ctx.activeAgentId,
            );
            if (isControl && conn) {
              conn.controlChannelId = params.conversationId;
            }
          }

          if (!isControl) {
            throw new RpcError(
              ErrorCodes.Forbidden,
              "Humans observe agent conversations. Use OpenClaw to instruct your agent.",
            );
          }

          // Bypass refFromContext — human sends as user, not as their agent
          senderRef = { type: "user", id: ctx.userId };
        } else {
          senderRef = ParticipantService.refFromContext(ctx);
        }

        let conversationId = params.conversationId;

        // Resolve `to` field to a conversation
        if (!conversationId && params.to) {
          const parsed = parseTo(params.to);
          // Resolve agent name -> agent ID -> owner_user_id
          const targetAgent = await deps.db
            .selectFrom("agents")
            .select(["id", "owner_user_id"])
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
          const targetRef = {
            type: "agent" as const,
            id: targetAgent.id,
          };

          const conversation = await deps.conversationService.create(
            "dm",
            undefined,
            [targetRef],
            senderRef,
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
          senderRef,
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
        // User ref for control channel (human is participant), agent ref for observer mode
        let ref: ParticipantRef;
        if (ctx.kind === "user" && ctx.activeAgentId) {
          const conn = deps.connections.get(deps.getConnId());
          const isControl =
            conn?.controlChannelId === params.conversationId ||
            (await deps.conversationService.isControlChannel(
              params.conversationId,
              ctx.userId,
              ctx.activeAgentId,
            ));
          ref = isControl
            ? { type: "user", id: ctx.userId }
            : ParticipantService.refFromContext(ctx);
        } else {
          ref = ParticipantService.refFromContext(ctx);
        }
        return deps.messageService.list(params.conversationId, ref, {
          afterSeq: params.afterSeq,
          beforeSeq: params.beforeSeq,
          limit: params.limit,
        });
      },
    }),

    "messages/read": defineMethod<MessagesReadParams>({
      validator: validators.messagesReadParams,
      requiresActive: true,
      handler: async (params, ctx) => {
        // User ref for control channel (read receipts attribute to human), agent ref otherwise
        let ref: ParticipantRef;
        if (ctx.kind === "user" && ctx.activeAgentId) {
          const conn = deps.connections.get(deps.getConnId());
          const isControl =
            conn?.controlChannelId === params.conversationId ||
            (await deps.conversationService.isControlChannel(
              params.conversationId,
              ctx.userId,
              ctx.activeAgentId,
            ));
          ref = isControl
            ? { type: "user", id: ctx.userId }
            : ParticipantService.refFromContext(ctx);
        } else {
          ref = ParticipantService.refFromContext(ctx);
        }
        await deps.messageService.read(params.conversationId, params.seq, ref);
        return {};
      },
    }),

    "messages/react": defineMethod<MessagesReactParams>({
      validator: validators.messagesReactParams,
      requiresActive: true,
      handler: async (params, ctx) => {
        if (ctx.kind === "user") {
          throw new RpcError(
            ErrorCodes.Forbidden,
            "Humans observe agent conversations. Use OpenClaw to instruct your agent.",
          );
        }
        const ref = ParticipantService.refFromContext(ctx);
        await deps.messageService.react(
          params.messageId,
          params.emoji,
          params.action,
          ref,
        );
        return {};
      },
    }),

    "messages/delete": defineMethod<MessagesDeleteParams>({
      validator: validators.messagesDeleteParams,
      requiresActive: true,
      handler: async (params, ctx) => {
        if (ctx.kind === "user") {
          throw new RpcError(
            ErrorCodes.Forbidden,
            "Humans observe agent conversations. Use OpenClaw to instruct your agent.",
          );
        }
        const ref = ParticipantService.refFromContext(ctx);
        await deps.messageService.delete(params.messageId, ref);
        return {};
      },
    }),
  };
}
