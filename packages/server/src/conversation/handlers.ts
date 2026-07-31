import { Effect } from "effect";
import {
  type agentConversationCreate as agentConversationCreateDefinition,
  conversationCreatedNotificationDefinition,
  type conversationList as conversationListDefinition,
  conversationParticipantsAddedNotificationDefinition,
  conversationParticipantsRemovedNotificationDefinition,
  type conversationUpdate as conversationUpdateDefinition,
  type Conversation,
  type ConversationListItem,
} from "@moltzap/protocol/conversation";

import type { AgentId } from "@moltzap/protocol/identity";
import type { ParamsOf } from "@moltzap/protocol/rpc";
import type { ServerHandler } from "@moltzap/protocol/socket/catalog";
import type { AppContext, AgentContext } from "#socket";
import { ConversationServiceTag } from "./layer.js";
import { agentArm, appArm } from "#moltzap/runtime";
import {
  assertCallerAppOwnsConversation,
  authorizeConversationCreateCapacityOnly,
} from "#conversation/requirements";
import { broadcastNotificationToAgents } from "#network";

const EMPTY_AGENT_IDS: readonly AgentId[] = [];

type ConversationUpdateParams = ParamsOf<typeof conversationUpdateDefinition>;
type ConversationAddParticipantParams = Extract<
  ConversationUpdateParams,
  { action: "add-participant" }
>;
type ConversationRemoveParticipantParams = Extract<
  ConversationUpdateParams,
  { action: "remove-participant" }
>;

function agentConversationCreateBody(
  params: ParamsOf<typeof agentConversationCreateDefinition>,
  ctx: AgentContext,
) {
  return Effect.gen(function* () {
    const conversationService = yield* ConversationServiceTag;
    const participants = [...params.participants];
    yield* authorizeConversationCreateCapacityOnly(participants);
    const conversation = yield* conversationService.create({
      ...(params.name === undefined ? {} : { name: params.name }),
      agentIds: participants,
      creatorAgentId: ctx.agentId,
      appId: params.appId,
    });
    yield* fanoutConversationCreate({
      conversation,
      participants: [ctx.agentId, ...participants],
      ...(params.name === undefined ? {} : { name: params.name }),
    });
    return { conversation };
  }).pipe(Effect.withSpan("conversation.create.agent"));
}

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

function conversationListBody(
  params: ParamsOf<typeof conversationListDefinition>,
  ctx: AgentContext,
) {
  return Effect.gen(function* () {
    const conversationService = yield* ConversationServiceTag;
    const { conversations, cursor: nextCursor } =
      yield* conversationService.list(ctx.agentId, params.limit, params.cursor);
    const items: ConversationListItem[] = [];
    for (const summary of conversations) {
      // The two per-conversation reads are independent; run them together.
      const { conversation, participants } = yield* Effect.all({
        conversation: conversationService.loadById(summary.id),
        participants: conversationService
          .getParticipantAgentIds(summary.id)
          .pipe(Effect.orElseSucceed(() => EMPTY_AGENT_IDS)),
      });
      items.push({
        conversation,
        participants: [...participants],
      });
    }
    return { items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
  }).pipe(Effect.withSpan("conversation.list"));
}

function conversationAddParticipantBody(
  params: ConversationAddParticipantParams,
  ctx: AppContext,
) {
  return Effect.gen(function* () {
    yield* assertCallerAppOwnsConversation(ctx.appId, params.conversationId);
    const conversationService = yield* ConversationServiceTag;
    const current = yield* conversationService.getParticipantAgentIds(
      params.conversationId,
    );
    if (!current.includes(params.agentId)) {
      yield* conversationService.assertGroupCapacity(current.length + 1);
    }
    const { postMutationParticipants } =
      yield* conversationService.addConversationParticipant(
        params.conversationId,
        params.agentId,
      );
    yield* broadcastNotificationToAgents(
      postMutationParticipants,
      conversationParticipantsAddedNotificationDefinition,
      {
        conversationId: params.conversationId,
        addedAgentId: params.agentId,
      },
    );
    return {};
  }).pipe(Effect.withSpan("conversation.participants.add"));
}

function conversationRemoveParticipantBody(
  params: ConversationRemoveParticipantParams,
  ctx: AppContext,
) {
  return Effect.gen(function* () {
    yield* assertCallerAppOwnsConversation(ctx.appId, params.conversationId);
    const conversationService = yield* ConversationServiceTag;
    const { preMutationParticipants, wasParticipant } =
      yield* conversationService.removeConversationParticipant(
        params.conversationId,
        params.agentId,
      );
    if (!wasParticipant) {
      return {};
    }
    yield* broadcastNotificationToAgents(
      preMutationParticipants,
      conversationParticipantsRemovedNotificationDefinition,
      {
        conversationId: params.conversationId,
        removedAgentId: params.agentId,
        reason: "app_remove" as const,
      },
    );
    return {};
  }).pipe(Effect.withSpan("conversation.participants.remove"));
}

function conversationUpdateBody(
  params: ConversationUpdateParams,
  ctx: AppContext,
) {
  switch (params.action) {
    case "add-participant":
      return conversationAddParticipantBody(params, ctx);
    case "remove-participant":
      return conversationRemoveParticipantBody(params, ctx);
    default: {
      const exhaustive: never = params;
      return exhaustive;
    }
  }
}

/**
 * Provides the conversation list runtime value.
 * @param params Request payload to process.
 * @returns The conversation list result.
 */
export const conversationList: ServerHandler<
  typeof conversationListDefinition
> = (params) =>
  Effect.gen(function* () {
    return yield* conversationListBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("conversationList"));

/**
 * Provides the agent conversation create runtime value.
 * @param params Request payload to process.
 * @returns The agent conversation create result.
 */
export const agentConversationCreate: ServerHandler<
  typeof agentConversationCreateDefinition
> = (params) =>
  Effect.gen(function* () {
    return yield* agentConversationCreateBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("agentConversationCreate"));

/**
 * Provides the conversation update runtime value.
 * @param params Request payload to process.
 * @returns The conversation update result.
 */
export const conversationUpdate: ServerHandler<
  typeof conversationUpdateDefinition
> = (params) =>
  Effect.gen(function* () {
    return yield* conversationUpdateBody(params, yield* appArm);
  }).pipe(Effect.withSpan("conversationUpdate"));
