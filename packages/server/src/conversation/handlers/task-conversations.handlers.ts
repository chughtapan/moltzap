import { Effect } from "effect";
import {
  TaskConversationAddParticipant,
  TaskConversationArchive,
  TaskConversationArchivedNotificationDefinition,
  TaskConversationCreate,
  TaskConversationCreatedNotificationDefinition,
  TaskConversationList,
  TaskConversationParticipantsAddedNotificationDefinition,
  TaskConversationParticipantsRemovedNotificationDefinition,
  TaskConversationRemoveParticipant,
  TaskConversationUnarchive,
  TaskConversationUnarchivedNotificationDefinition,
} from "@moltzap/protocol/conversation";
import type {
  Conversation,
  ConversationId,
  TaskConversationListItem,
} from "@moltzap/protocol/conversation";
import type { ParamsOf } from "@moltzap/protocol/rpc";
import type { ServerHandler } from "@moltzap/protocol/socket";
import type { AppContext, AgentContext } from "#socket";
import type { AgentId } from "#core";
import { ConversationServiceTag, TaskServiceTag } from "#core";
import { authorizeConversationCreateCapacityOnly } from "#conversation/requirements";
import { broadcastNotificationToAgents } from "#network";
import { assertCallerAppOwnsTask } from "#task/requirements";
import { agentArm, appArm } from "#core";

function taskConversationCreateBody(
  appId: AppContext["appId"],
  params: {
    readonly taskId: ParamsOf<typeof TaskConversationCreate>["taskId"];
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
    yield* fanoutTaskConversationCreate({
      taskId: params.taskId,
      conversation,
      participants: params.participants,
      name: params.name,
    });
    return { conversation };
  }).pipe(Effect.withSpan("task.conversation.create"));
}

interface TaskConversationCreateInput {
  readonly taskId: ParamsOf<typeof TaskConversationCreate>["taskId"];
  readonly conversation: Conversation;
  readonly participants: ReadonlyArray<AgentId>;
  readonly name?: string;
}

function fanoutTaskConversationCreate(input: TaskConversationCreateInput) {
  return broadcastNotificationToAgents(
    [...input.participants],
    TaskConversationCreatedNotificationDefinition,
    {
      taskId: input.taskId,
      conversationId: input.conversation.id,
      name: input.name,
      participants: [...input.participants],
    },
  ).pipe(Effect.withSpan("task.conversation.create.fanout"));
}

interface ArchiveFanoutInput {
  readonly taskId: ParamsOf<typeof TaskConversationArchive>["taskId"];
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
      TaskConversationArchivedNotificationDefinition,
      {
        taskId: input.taskId,
        conversationId: input.conversationId,
        archivedAt: input.archivedAt,
      },
      { forConversation: input.conversationId },
    );
  }).pipe(Effect.withSpan("task.conversation.archive.fanout"));
}

interface UnarchiveFanoutInput {
  readonly taskId: ParamsOf<typeof TaskConversationUnarchive>["taskId"];
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
      TaskConversationUnarchivedNotificationDefinition,
      {
        taskId: input.taskId,
        conversationId: input.conversationId,
      },
      { forConversation: input.conversationId },
    );
  }).pipe(Effect.withSpan("task.conversation.unarchive.fanout"));
}

function taskConversationListBody(
  params: ParamsOf<typeof TaskConversationList>,
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
    const items: TaskConversationListItem[] = [];
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
  }).pipe(Effect.withSpan("task.conversation.list"));
}

function taskConversationArchiveBody(
  params: ParamsOf<typeof TaskConversationArchive>,
  ctx: AppContext,
) {
  return Effect.gen(function* () {
    yield* assertCallerAppOwnsTask(ctx.appId, params.taskId);
    const taskService = yield* TaskServiceTag;
    const { archivedAt } = yield* taskService.archiveTaskConversation(
      params.taskId,
      params.conversationId,
    );
    yield* fanoutArchive({
      taskId: params.taskId,
      conversationId: params.conversationId,
      archivedAt,
    });
    return {};
  }).pipe(Effect.withSpan("task.conversation.archive"));
}

function taskConversationUnarchiveBody(
  params: ParamsOf<typeof TaskConversationUnarchive>,
  ctx: AppContext,
) {
  return Effect.gen(function* () {
    yield* assertCallerAppOwnsTask(ctx.appId, params.taskId);
    const taskService = yield* TaskServiceTag;
    yield* taskService.unarchiveTaskConversation(
      params.taskId,
      params.conversationId,
    );
    yield* fanoutUnarchive({
      taskId: params.taskId,
      conversationId: params.conversationId,
    });
    return {};
  }).pipe(Effect.withSpan("task.conversation.unarchive"));
}

function taskConversationAddParticipantBody(
  params: ParamsOf<typeof TaskConversationAddParticipant>,
  ctx: AppContext,
) {
  return Effect.gen(function* () {
    yield* assertCallerAppOwnsTask(ctx.appId, params.taskId);
    const taskService = yield* TaskServiceTag;
    yield* taskService.requireAgentsAreInTaskParticipants(params.taskId, [
      params.agentId,
    ]);
    const { postMutationParticipants } =
      yield* taskService.addTaskConversationParticipant(
        params.taskId,
        params.conversationId,
        params.agentId,
      );
    yield* broadcastNotificationToAgents(
      postMutationParticipants,
      TaskConversationParticipantsAddedNotificationDefinition,
      {
        taskId: params.taskId,
        conversationId: params.conversationId,
        addedAgentId: params.agentId,
      },
    );
    return {};
  }).pipe(Effect.withSpan("task.conversation.participants.add"));
}

function taskConversationRemoveParticipantBody(
  params: ParamsOf<typeof TaskConversationRemoveParticipant>,
  ctx: AppContext,
) {
  return Effect.gen(function* () {
    yield* assertCallerAppOwnsTask(ctx.appId, params.taskId);
    const taskService = yield* TaskServiceTag;
    const { preMutationParticipants, wasParticipant } =
      yield* taskService.removeTaskConversationParticipant(
        params.taskId,
        params.conversationId,
        params.agentId,
      );
    if (!wasParticipant) return {};
    yield* broadcastNotificationToAgents(
      preMutationParticipants,
      TaskConversationParticipantsRemovedNotificationDefinition,
      {
        taskId: params.taskId,
        conversationId: params.conversationId,
        removedAgentId: params.agentId,
        reason: "app_remove" as const,
      },
    );
    return {};
  }).pipe(Effect.withSpan("task.conversation.participants.remove"));
}

export const taskConversationList: ServerHandler<
  typeof TaskConversationList
> = (params) =>
  Effect.gen(function* () {
    return yield* taskConversationListBody(params, yield* agentArm);
  }).pipe(Effect.withSpan("taskConversationList"));

export const taskConversationCreate: ServerHandler<
  typeof TaskConversationCreate
> = (params) =>
  Effect.gen(function* () {
    return yield* taskConversationCreateBody((yield* appArm).appId, params);
  }).pipe(Effect.withSpan("taskConversationCreate"));

export const taskConversationArchive: ServerHandler<
  typeof TaskConversationArchive
> = (params) =>
  Effect.gen(function* () {
    return yield* taskConversationArchiveBody(params, yield* appArm);
  }).pipe(Effect.withSpan("taskConversationArchive"));

export const taskConversationUnarchive: ServerHandler<
  typeof TaskConversationUnarchive
> = (params) =>
  Effect.gen(function* () {
    return yield* taskConversationUnarchiveBody(params, yield* appArm);
  }).pipe(Effect.withSpan("taskConversationUnarchive"));

export const taskConversationAddParticipant: ServerHandler<
  typeof TaskConversationAddParticipant
> = (params) =>
  Effect.gen(function* () {
    return yield* taskConversationAddParticipantBody(params, yield* appArm);
  }).pipe(Effect.withSpan("taskConversationAddParticipant"));

export const taskConversationRemoveParticipant: ServerHandler<
  typeof TaskConversationRemoveParticipant
> = (params) =>
  Effect.gen(function* () {
    return yield* taskConversationRemoveParticipantBody(params, yield* appArm);
  }).pipe(Effect.withSpan("taskConversationRemoveParticipant"));
