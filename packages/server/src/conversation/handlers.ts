import { Effect } from "effect";
import {
  ConversationArchivedNotificationDefinition,
  ConversationCreate,
  ConversationCreatedNotificationDefinition,
  ConversationList,
  ConversationParticipantsAddedNotificationDefinition,
  ConversationParticipantsRemovedNotificationDefinition,
  ConversationUpdate,
  ConversationUnarchivedNotificationDefinition,
} from "@moltzap/protocol/conversation";
import type {
  Conversation,
  ConversationId,
  ConversationListItem,
} from "@moltzap/protocol/conversation";
import type { ParamsOf } from "@moltzap/protocol/rpc";
import type { ServerHandler } from "@moltzap/protocol/socket/catalog";
import type { AppContext, AgentContext } from "#socket";
import type { AgentId } from "#core";
import { ConversationServiceTag, TaskServiceTag } from "#core";
import { agentArm, appArm } from "#moltzap";
import { authorizeConversationCreateCapacityOnly } from "#conversation/requirements";
import { broadcastNotificationToAgents } from "#network";
import { assertCallerAppOwnsTask } from "#task/requirements";

type ConversationUpdateParams = ParamsOf<typeof ConversationUpdate>;
type ConversationArchiveParams = Extract<
  ConversationUpdateParams,
  { action: "archive" }
>;
type ConversationUnarchiveParams = Extract<
  ConversationUpdateParams,
  { action: "unarchive" }
>;
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
    readonly taskId: ParamsOf<typeof ConversationCreate>["taskId"];
    readonly name?: string;
    readonly participants: ReadonlyArray<AgentId>;
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
  readonly taskId: ParamsOf<typeof ConversationCreate>["taskId"];
  readonly conversation: Conversation;
  readonly participants: ReadonlyArray<AgentId>;
  readonly name?: string;
}

function fanoutConversationCreate(input: ConversationCreateInput) {
  return broadcastNotificationToAgents(
    [...input.participants],
    ConversationCreatedNotificationDefinition,
    {
      taskId: input.taskId,
      conversationId: input.conversation.id,
      name: input.name,
      participants: [...input.participants],
    },
  ).pipe(Effect.withSpan("conversation.create.fanout"));
}

interface ArchiveFanoutInput {
  readonly taskId: ConversationArchiveParams["taskId"];
  readonly conversationId: ConversationId;
  readonly archivedAt: string;
}

function fanoutArchive(input: ArchiveFanoutInput) {
  return Effect.gen(function* () {
    const conversationService = yield* ConversationServiceTag;
    const recipientAgentIds = yield* conversationService
      .getParticipantAgentIds(input.conversationId)
      .pipe(Effect.orElseSucceed(() => [] as readonly AgentId[]));
    yield* broadcastNotificationToAgents(
      recipientAgentIds,
      ConversationArchivedNotificationDefinition,
      {
        taskId: input.taskId,
        conversationId: input.conversationId,
        archivedAt: input.archivedAt,
      },
      { forConversation: input.conversationId },
    );
  }).pipe(Effect.withSpan("conversation.archive.fanout"));
}

interface UnarchiveFanoutInput {
  readonly taskId: ConversationUnarchiveParams["taskId"];
  readonly conversationId: ConversationId;
}

function fanoutUnarchive(input: UnarchiveFanoutInput) {
  return Effect.gen(function* () {
    const conversationService = yield* ConversationServiceTag;
    const recipientAgentIds = yield* conversationService
      .getParticipantAgentIds(input.conversationId)
      .pipe(Effect.orElseSucceed(() => [] as readonly AgentId[]));
    yield* broadcastNotificationToAgents(
      recipientAgentIds,
      ConversationUnarchivedNotificationDefinition,
      {
        taskId: input.taskId,
        conversationId: input.conversationId,
      },
      { forConversation: input.conversationId },
    );
  }).pipe(Effect.withSpan("conversation.unarchive.fanout"));
}

function conversationListBody(
  params: ParamsOf<typeof ConversationList>,
  ctx: AgentContext,
) {
  return Effect.gen(function* () {
    const conversationService = yield* ConversationServiceTag;
    const { conversations, cursor: nextCursor } =
      yield* conversationService.list(
        ctx.agentId,
        params.limit,
        params.cursor,
        "include",
      );
    const items: ConversationListItem[] = [];
    for (const summary of conversations) {
      const conversation = yield* conversationService.loadById(summary.id);
      const participants = yield* conversationService
        .getParticipantAgentIds(summary.id)
        .pipe(Effect.orElseSucceed(() => [] as readonly AgentId[]));
      const linkedTaskId = yield* conversationService.taskIdForConversation(
        summary.id,
      );
      items.push({
        taskId: linkedTaskId,
        conversation,
        participants: [...participants],
      });
    }
    return { items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
  }).pipe(Effect.withSpan("conversation.list"));
}

function conversationArchiveBody(
  params: ConversationArchiveParams,
  ctx: AppContext,
) {
  return Effect.gen(function* () {
    yield* assertCallerAppOwnsTask(ctx.appId, params.taskId);
    const taskService = yield* TaskServiceTag;
    const { archivedAt } = yield* taskService.archiveConversation(
      params.taskId,
      params.conversationId,
    );
    yield* fanoutArchive({
      taskId: params.taskId,
      conversationId: params.conversationId,
      archivedAt,
    });
    return {};
  }).pipe(Effect.withSpan("conversation.archive"));
}

function conversationUnarchiveBody(
  params: ConversationUnarchiveParams,
  ctx: AppContext,
) {
  return Effect.gen(function* () {
    yield* assertCallerAppOwnsTask(ctx.appId, params.taskId);
    const taskService = yield* TaskServiceTag;
    yield* taskService.unarchiveConversation(
      params.taskId,
      params.conversationId,
    );
    yield* fanoutUnarchive({
      taskId: params.taskId,
      conversationId: params.conversationId,
    });
    return {};
  }).pipe(Effect.withSpan("conversation.unarchive"));
}

function conversationAddParticipantBody(
  params: ConversationAddParticipantParams,
  ctx: AppContext,
) {
  return Effect.gen(function* () {
    yield* assertCallerAppOwnsTask(ctx.appId, params.taskId);
    const taskService = yield* TaskServiceTag;
    yield* taskService.requireAgentsAreInTaskParticipants(params.taskId, [
      params.agentId,
    ]);
    const { postMutationParticipants } =
      yield* taskService.addConversationParticipant(
        params.taskId,
        params.conversationId,
        params.agentId,
      );
    yield* broadcastNotificationToAgents(
      postMutationParticipants,
      ConversationParticipantsAddedNotificationDefinition,
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
    yield* assertCallerAppOwnsTask(ctx.appId, params.taskId);
    const taskService = yield* TaskServiceTag;
    const { preMutationParticipants, wasParticipant } =
      yield* taskService.removeConversationParticipant(
        params.taskId,
        params.conversationId,
        params.agentId,
      );
    if (!wasParticipant) return {};
    yield* broadcastNotificationToAgents(
      preMutationParticipants,
      ConversationParticipantsRemovedNotificationDefinition,
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
    case "archive":
      return conversationArchiveBody(params, ctx);
    case "unarchive":
      return conversationUnarchiveBody(params, ctx);
    case "add-participant":
      return conversationAddParticipantBody(params, ctx);
    case "remove-participant":
      return conversationRemoveParticipantBody(params, ctx);
  }
}

export const conversationList: ServerHandler<typeof ConversationList> = (
  params,
) =>
  Effect.gen(function* () {
    return yield* conversationListBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("conversationList"));

export const conversationCreate: ServerHandler<typeof ConversationCreate> = (
  params,
) =>
  Effect.gen(function* () {
    return yield* conversationCreateBody((yield* appArm).appId, params);
  }).pipe(Effect.withSpan("conversationCreate"));

export const conversationUpdate: ServerHandler<typeof ConversationUpdate> = (
  params,
) =>
  Effect.gen(function* () {
    return yield* conversationUpdateBody(params, yield* appArm);
  }).pipe(Effect.withSpan("conversationUpdate"));
