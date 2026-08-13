// safer-arch-ignore no-cross-domain-sibling-import: Protocol handler bodies read their already-gated principal through the MoltZap adapter boundary.
import type { messagesSend as messagesSendDefinition } from "@moltzap/protocol/message";
import type { ParamsOf } from "@moltzap/protocol/rpc";
import type { ServerHandler } from "@moltzap/protocol/socket/catalog";
import { agentArm } from "../moltzap/principal-gate.js";
import { Effect } from "effect";
import { ConnectionTag, type AgentContext } from "#socket";
import { MessageServiceTag } from "./message.service.js";

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
