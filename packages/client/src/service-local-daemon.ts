import type { RpcGroup } from "@effect/rpc";
import { Effect, Either } from "effect";
import {
  AgentsLookupByName,
  AgentsList,
  ContactsAccept,
  ContactsAdd,
  ContactsList,
  type AgentId,
} from "@moltzap/protocol/identity";
import { AgentCallableGroup } from "@moltzap/protocol/rpc-method-groups";
import {
  DEFAULT_APP_ID,
  TaskConversationList,
  TaskRequest,
  type TaskId,
} from "@moltzap/protocol/task";
import type { ConversationId, MessageId } from "@moltzap/protocol/conversation";
import { MessagesList, MessagesSend } from "@moltzap/protocol/message";
import type {
  PayloadForTag,
  ResultOf,
  SuccessForTag,
} from "@moltzap/protocol/transport";
import type { RpcCallOptions } from "./agent-client.js";
import type { ServiceRpcError } from "./service.js";
import type { HistoryRequest, HistoryResponse } from "./local-history.js";
import {
  LocalDaemonCommands,
  ServiceInputError,
  StartTaskPartialFailure,
  StartTaskUsageError,
  type LocalDaemonHandlers,
  type SendCommandPayload,
  type StartParticipant,
  type StartTaskCommandPayload,
  type StartTaskCommandResult,
} from "./local-daemon-rpc.js";

type AgentCallableRpcs = RpcGroup.Rpcs<typeof AgentCallableGroup>;
type AgentCallableTag = AgentCallableRpcs["_tag"];

type ServiceCall = <Tag extends AgentCallableTag>(
  tag: Tag,
  payload: PayloadForTag<AgentCallableRpcs, Tag>,
  opts?: RpcCallOptions,
) => Effect.Effect<SuccessForTag<AgentCallableRpcs, Tag>, ServiceRpcError>;

interface LocalDaemonHandlerOptions {
  readonly ownAgentId: AgentId;
  readonly connected: boolean;
  readonly conversationCount: () => number;
  readonly call: ServiceCall;
  readonly handleHistoryRequest: (
    request: HistoryRequest,
  ) => Effect.Effect<HistoryResponse, ServiceRpcError>;
}

interface StartMessageInput {
  readonly call: ServiceCall;
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly reusedConversation: boolean;
  readonly text: string;
}

interface OptionalStartMessageInput {
  readonly call: ServiceCall;
  readonly params: StartTaskCommandPayload;
  readonly taskId: TaskId;
  readonly conversationId: ConversationId;
  readonly reusedConversation: boolean;
}

const MAX_START_PARTICIPANT_LOOKUP_NAMES = 100;

function startParticipantNames(
  participants: readonly StartParticipant[],
): readonly string[] {
  return Array.from(
    new Set(
      participants.flatMap((entry) =>
        entry.kind === "name" ? [entry.name] : [],
      ),
    ),
  );
}

function initialStartConversation(
  name: string,
  invitedAgentIds: readonly AgentId[],
) {
  return invitedAgentIds.length === 0
    ? { name }
    : { name, participants: invitedAgentIds };
}

function resolveStartParticipantIds(
  participants: readonly StartParticipant[],
  byName: ReadonlyMap<string, AgentId>,
): Effect.Effect<readonly AgentId[], StartTaskUsageError> {
  return Effect.gen(function* () {
    const resolved: AgentId[] = [];
    for (const entry of participants) {
      if (entry.kind === "id") {
        resolved.push(entry.id);
        continue;
      }
      const id = byName.get(entry.name);
      if (id === undefined) {
        return yield* Effect.fail(
          new StartTaskUsageError({
            message: `Cannot resolve "${entry.token}": not-found`,
          }),
        );
      }
      resolved.push(id);
    }
    return resolved;
  });
}

function handleSendCommand(
  call: ServiceCall,
  params: SendCommandPayload,
): Effect.Effect<{ readonly messageId: MessageId }, ServiceRpcError> {
  return call(MessagesSend.name, {
    taskId: params.target.taskId,
    conversationId: params.target.conversationId,
    parts: [{ type: "text", text: params.message }],
    ...(params.replyToId === undefined ? {} : { replyToId: params.replyToId }),
  }).pipe(Effect.map((result) => ({ messageId: result.message.id })));
}

function resolveStartParticipants(
  call: ServiceCall,
  participants: readonly StartParticipant[],
): Effect.Effect<readonly AgentId[], StartTaskUsageError | ServiceRpcError> {
  return Effect.gen(function* () {
    const names = startParticipantNames(participants);
    if (names.length > MAX_START_PARTICIPANT_LOOKUP_NAMES) {
      return yield* Effect.fail(
        new StartTaskUsageError({
          message: `Too many distinct agent names: ${names.length} (max ${MAX_START_PARTICIPANT_LOOKUP_NAMES})`,
        }),
      );
    }
    const byName = new Map<string, AgentId>();
    if (names.length > 0) {
      const result = yield* call(AgentsLookupByName.name, { names });
      for (const agent of result.agents) {
        if (!byName.has(agent.name)) byName.set(agent.name, agent.id);
      }
    }
    return yield* resolveStartParticipantIds(participants, byName);
  });
}

function findReusableStartConversation(
  call: ServiceCall,
  taskId: TaskId,
): Effect.Effect<ConversationId | null, ServiceRpcError> {
  return Effect.gen(function* () {
    let cursor: string | undefined = undefined;
    for (let page = 0; page < 10; page++) {
      const result: ResultOf<typeof TaskConversationList> = yield* call(
        TaskConversationList.name,
        {
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        },
      );
      const hit = result.items.find(
        (item) =>
          item.taskId === taskId && item.conversation.archivedAt === undefined,
      );
      if (hit !== undefined) return hit.conversation.id;
      if (result.nextCursor === undefined) return null;
      cursor = result.nextCursor;
    }
    return null;
  });
}

function sendStartMessage({
  call,
  taskId,
  conversationId,
  reusedConversation,
  text,
}: StartMessageInput): Effect.Effect<
  MessageId,
  StartTaskPartialFailure | ServiceRpcError
> {
  return Effect.either(
    call(MessagesSend.name, {
      taskId,
      conversationId,
      parts: [{ type: "text", text }],
    }),
  ).pipe(
    Effect.flatMap((outcome) =>
      Either.match(outcome, {
        onRight: (result) => Effect.succeed(result.message.id),
        onLeft: (error) =>
          Effect.fail(
            new StartTaskPartialFailure({
              taskId,
              conversationId,
              reusedConversation,
              message: error instanceof Error ? error.message : String(error),
            }),
          ),
      }),
    ),
  );
}

function sendOptionalStartMessage({
  call,
  params,
  taskId,
  conversationId,
  reusedConversation,
}: OptionalStartMessageInput): Effect.Effect<
  MessageId | undefined,
  StartTaskPartialFailure | ServiceRpcError
> {
  if (params.message === undefined) return Effect.succeed(undefined);
  return sendStartMessage({
    call,
    taskId,
    conversationId,
    reusedConversation,
    text: params.message,
  });
}

function handleStartTaskCommand(
  call: ServiceCall,
  params: StartTaskCommandPayload,
): Effect.Effect<
  StartTaskCommandResult,
  | StartTaskUsageError
  | StartTaskPartialFailure
  | ServiceInputError
  | ServiceRpcError
> {
  return Effect.gen(function* () {
    const appId = params.appId ?? DEFAULT_APP_ID;
    const invitedAgentIds = yield* resolveStartParticipants(
      call,
      params.participants,
    );
    const result = yield* call(TaskRequest.name, {
      appId,
      invitedAgentIds,
      initialConversation: initialStartConversation(
        params.name,
        invitedAgentIds,
      ),
    });
    const reusedConversation = result.conversation === null;
    const conversationId =
      result.conversation?.id ??
      (yield* findReusableStartConversation(call, result.task.id));
    if (conversationId === null) {
      return yield* Effect.fail(
        new ServiceInputError({
          message: `Task already exists but is closed: ${result.task.id}`,
        }),
      );
    }
    const sentMessageId = yield* sendOptionalStartMessage({
      call,
      params,
      taskId: result.task.id,
      conversationId,
      reusedConversation,
    });
    return {
      taskId: result.task.id,
      conversationId,
      reusedConversation,
      ...(sentMessageId === undefined ? {} : { sentMessageId }),
    };
  }).pipe(Effect.withSpan("MoltZapService.handleStartTaskCommand"));
}

export function makeLocalDaemonHandlers({
  ownAgentId,
  connected,
  conversationCount,
  call,
  handleHistoryRequest,
}: LocalDaemonHandlerOptions): LocalDaemonHandlers {
  return {
    [LocalDaemonCommands.Status]: () =>
      Effect.succeed({
        agentId: ownAgentId,
        connected,
        conversations: conversationCount(),
      }),
    [LocalDaemonCommands.History]: handleHistoryRequest,
    [LocalDaemonCommands.AgentsList]: (params) =>
      call(
        AgentsList.name,
        params.limit === undefined ? {} : { limit: params.limit },
      ),
    [LocalDaemonCommands.AgentsLookup]: (params) =>
      call(AgentsLookupByName.name, { names: params.names }),
    [LocalDaemonCommands.ContactsList]: () => call(ContactsList.name, {}),
    [LocalDaemonCommands.ContactsAdd]: (params) =>
      call(ContactsAdd.name, { contactUserId: params.userId }),
    [LocalDaemonCommands.ContactsAccept]: (params) =>
      call(ContactsAccept.name, { contactId: params.contactId }),
    [LocalDaemonCommands.MessagesList]: (params) =>
      call(MessagesList.name, {
        taskId: params.taskId,
        conversationId: params.conversationId,
        ...(params.limit === undefined ? {} : { limit: params.limit }),
      }),
    [LocalDaemonCommands.Send]: (params) => handleSendCommand(call, params),
    [LocalDaemonCommands.StartTask]: (params) =>
      handleStartTaskCommand(call, params),
  };
}
