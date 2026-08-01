import type {
  messagesList as messagesListDefinition,
  messagesSend as messagesSendDefinition,
} from "@moltzap/protocol/message";
import type { ParamsOf } from "@moltzap/protocol/rpc";
import type { ServerHandler } from "@moltzap/protocol/socket/catalog";
import { agentArm } from "#moltzap/runtime";
import { Effect } from "effect";
import { ConnectionTag, type AgentContext } from "#socket";
import { MessageServiceTag } from "./layer.js";

type MessagesSendParams = ParamsOf<typeof messagesSendDefinition>;

const handleMessageSend = Effect.fn("messages.send")(function* (
  params: MessagesSendParams,
  ctx: AgentContext,
) {
  const messageService = yield* MessageServiceTag;
  const connection = yield* ConnectionTag;
  const message = yield* messageService.send({
    conversationId: params.conversationId,
    parts: params.parts,
    senderAgentId: ctx.agentId,
    excludeConnectionId: connection.connId,
  });
  return { message };
});

const handleMessageList = Effect.fn("messages.list")(function* (
  params: ParamsOf<typeof messagesListDefinition>,
  ctx: AgentContext,
) {
  const messageService = yield* MessageServiceTag;
  return yield* messageService.list(params.conversationId, ctx.agentId, {
    limit: params.limit,
  });
});

// ── @effect/rpc handler bodies ───────────────────────────────────────
//
// Requirement middleware gates each frame before these bodies run. The bodies
// narrow the arm via `agentArm`, run the same domain work as the live slot path,
// and leave `ConnectionTag` + domain services to the request runtime.

/**
 * Provides the messages send runtime value.
 * @param params Request payload to process.
 * @returns The messages send result.
 */
export const messagesSend: ServerHandler<typeof messagesSendDefinition> =
  Effect.fn("messagesSend")(function* (params) {
    // The send-permission requirements gated this frame in the engine stack
    // before this handler runs. `agentArm` reads the narrowed principal off
    // `ConnectionTag`.
    const ctx = yield* agentArm;
    return yield* handleMessageSend(params, ctx);
  });

/**
 * Provides the messages list runtime value.
 * @param params Request payload to process.
 * @returns The messages list result.
 */
export const messagesList: ServerHandler<typeof messagesListDefinition> =
  Effect.fn("messagesList")(function* (params) {
    // Conversation participation is the whole read gate, asserted by
    // `MessageService.list` before any row is projected.
    const ctx = yield* agentArm;
    return yield* handleMessageList(params, ctx);
  });
