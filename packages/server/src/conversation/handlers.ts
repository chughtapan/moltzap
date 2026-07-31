import { Effect } from "effect";
import {
  type conversationCreate as conversationCreateDefinition,
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
import { TaskServiceTag } from "#task";
import { agentArm, appArm } from "#moltzap/runtime";
import {
  assertCallerAppOwnsConversation,
  authorizeConversationCreateCapacityOnly,
} from "#conversation/requirements";
import { broadcastNotificationToAgents } from "#network";
import { assertCallerAppOwnsTask } from "#task/requirements";

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

function conversationCreateBody(
  appId: AppContext["appId"],
  params: {
    readonly taskId: ParamsOf<typeof conversationCreateDefinition>["taskId"];
    readonly name?: string;
    readonly participants: readonly AgentId[];
  },
) {
  return Effect.gen(function* () {
    const task = yield* assertCallerAppOwnsTask(appId, params.taskId);
    const taskService = yield* TaskServiceTag;
    const conversationService = yield* ConversationServiceTag;
    yield* taskService.requireAgentsAreInTaskParticipants(
      params.taskId,
      params.participants,
    );
    yield* authorizeConversationCreateCapacityOnly([...params.participants]);
    const conversation = yield* conversationService.create({
      name: params.name,
      agentIds: [...params.participants],
      creatorAgentId: task.initiatorAgentId,
      appId,
      seedCreatorAsParticipant: false,
      mintTask: Effect.succeed({ id: params.taskId }),
    });
    yield* fanoutConversationCreate({
      taskId: params.taskId,
      conversation,
      participants: params.participants,
      name: params.name,
    });
    return { conversation };
  }).pipe(Effect.withSpan("conversation.create"));
}

interface ConversationCreateInput {
  readonly taskId: ParamsOf<typeof conversationCreateDefinition>["taskId"];
  readonly conversation: Conversation;
  readonly participants: readonly AgentId[];
  readonly name?: string;
}

function fanoutConversationCreate(input: ConversationCreateInput) {
  return broadcastNotificationToAgents(
    [...input.participants],
    conversationCreatedNotificationDefinition,
    {
      taskId: input.taskId,
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
      // The three per-conversation reads are independent; run them together.
      const { conversation, participants, linkedTaskId } = yield* Effect.all({
        conversation: conversationService.loadById(summary.id),
        participants: conversationService
          .getParticipantAgentIds(summary.id)
          .pipe(Effect.orElseSucceed(() => EMPTY_AGENT_IDS)),
        linkedTaskId: conversationService.taskIdForConversation(summary.id),
      });
      items.push({
        taskId: linkedTaskId,
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
    const taskService = yield* TaskServiceTag;
    yield* taskService.requireAgentsAreInTaskParticipants(params.taskId, [
      params.agentId,
    ]);
    const { postMutationParticipants } =
      yield* taskService.addConversationParticipant(
        params.conversationId,
        params.agentId,
      );
    yield* broadcastNotificationToAgents(
      postMutationParticipants,
      conversationParticipantsAddedNotificationDefinition,
      {
        taskId: params.taskId,
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
    const taskService = yield* TaskServiceTag;
    const { preMutationParticipants, wasParticipant } =
      yield* taskService.removeConversationParticipant(
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
        taskId: params.taskId,
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
 * Provides the conversation create runtime value.
 * @param params Request payload to process.
 * @returns The conversation create result.
 */
export const conversationCreate: ServerHandler<
  typeof conversationCreateDefinition
> = (params) =>
  Effect.gen(function* () {
    return yield* conversationCreateBody((yield* appArm).appId, params);
  }).pipe(Effect.withSpan("conversationCreate"));

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
