// safer-arch-ignore no-cross-domain-sibling-import: Protocol handler bodies read their already-gated principal through the MoltZap adapter boundary.
import { Effect } from "effect";
import { type agentConversationCreate as agentConversationCreateDefinition } from "@moltzap/protocol/conversation";

import type { ParamsOf } from "@moltzap/protocol/rpc";
import type { ServerHandler } from "@moltzap/protocol/socket/catalog";
import type { AgentContext } from "#socket";
import { ConversationServiceTag } from "./conversation.service.js";
import { agentArm } from "../moltzap/principal-gate.js";
import { authorizeConversationCreateCapacityOnly } from "#conversation/requirements";

const agentConversationCreateBody = Effect.fn("conversation.create.agent")(
  function* (
    params: ParamsOf<typeof agentConversationCreateDefinition>,
    ctx: AgentContext,
  ) {
    const conversationService = yield* ConversationServiceTag;
    // Deduped once at the boundary so a repeated participant id cannot
    // amplify membership writes.
    const participants = [...new Set(params.participants)];
    yield* authorizeConversationCreateCapacityOnly(participants);
    const conversation = yield* conversationService.create({
      ...(params.name === undefined ? {} : { name: params.name }),
      agentIds: participants,
      creatorAgentId: ctx.agentId,
    });
    return { conversation };
  },
);

/**
 * Provides the agent conversation create runtime value.
 * @param params Request payload to process.
 * @returns The agent conversation create result.
 */
export const agentConversationCreate: ServerHandler<
  typeof agentConversationCreateDefinition
> = Effect.fn("agentConversationCreate")(function* (params) {
  return yield* agentConversationCreateBody(params, yield* agentArm);
});
