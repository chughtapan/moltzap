// safer-arch-ignore no-cross-domain-sibling-import: Protocol handler bodies read their already-gated principal through the MoltZap adapter boundary.
import { Effect } from "effect";
import {
  type agentConversationCreate as agentConversationCreateDefinition,
  conversationCreatedNotificationDefinition,
  type conversationList as conversationListDefinition,
  type Conversation,
  type ConversationListItem,
} from "@moltzap/protocol/conversation";

import type { AgentId } from "@moltzap/protocol/identity";
import type { ParamsOf } from "@moltzap/protocol/rpc";
import type { ServerHandler } from "@moltzap/protocol/socket/catalog";
import type { AgentContext } from "#socket";
import { ConversationServiceTag } from "./layer.js";
import { agentArm } from "../moltzap/handler-runtime.js";
import { authorizeConversationCreateCapacityOnly } from "#conversation/requirements";
import { broadcastNotificationToAgents } from "#network";

const agentConversationCreateBody = Effect.fn("conversation.create.agent")(
  function* (
    params: ParamsOf<typeof agentConversationCreateDefinition>,
    ctx: AgentContext,
  ) {
    const conversationService = yield* ConversationServiceTag;
    // Deduped once at the boundary: creation, the created notification's
    // membership payload, and its fan-out all work from the same set, so a
    // repeated participant id cannot amplify notifications or desync the
    // payload from the stored membership.
    const participants = [...new Set(params.participants)];
    yield* authorizeConversationCreateCapacityOnly(participants);
    const conversation = yield* conversationService.create({
      ...(params.name === undefined ? {} : { name: params.name }),
      agentIds: participants,
      creatorAgentId: ctx.agentId,
    });
    yield* fanoutConversationCreate({
      conversation,
      participants: [...new Set([ctx.agentId, ...participants])],
      ...(params.name === undefined ? {} : { name: params.name }),
    });
    return { conversation };
  },
);

interface ConversationCreateInput {
  readonly conversation: Conversation;
  readonly participants: readonly AgentId[];
  readonly name?: string;
}

function fanoutConversationCreate(input: ConversationCreateInput) {
  return broadcastNotificationToAgents(
    [...input.participants],
    conversationCreatedNotificationDefinition,
    {
      conversationId: input.conversation.id,
      name: input.name,
      participants: [...input.participants],
    },
  ).pipe(Effect.withSpan("conversation.create.fanout"));
}

const conversationListBody = Effect.fn("conversation.list")(function* (
  params: ParamsOf<typeof conversationListDefinition>,
  ctx: AgentContext,
) {
  const conversationService = yield* ConversationServiceTag;
  const { items: page, cursor: nextCursor } = yield* conversationService.list(
    ctx.agentId,
    params.limit,
    params.cursor,
  );
  const items: ConversationListItem[] = page.map((entry) => ({
    conversation: entry.conversation,
    participants: [...entry.participants],
  }));
  return { items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
});

/**
 * Provides the conversation list runtime value.
 * @param params Request payload to process.
 * @returns The conversation list result.
 */
export const conversationList: ServerHandler<
  typeof conversationListDefinition
> = Effect.fn("conversationList")(function* (params) {
  return yield* conversationListBody(params, yield* agentArm);
});

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
