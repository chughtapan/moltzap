import type { RpcGroup } from "@effect/rpc";
import { Effect, Either } from "effect";
import { agentsList, type AgentId } from "@moltzap/protocol/identity";
import type { agentCallableGroup } from "@moltzap/protocol/socket/catalog";
import {
  conversationList,
  type ConversationId,
  type MessageId,
} from "@moltzap/protocol/conversation";
import {
  DEFAULT_APP_ID,
  taskRequest,
  type TaskId,
} from "@moltzap/protocol/task";
import { messagesList, messagesSend } from "@moltzap/protocol/message";
import type {
  ListCursor,
  PayloadForTag,
  ResultOf,
  SuccessForTag,
} from "@moltzap/protocol/rpc";
import type { RpcCallOptions } from "./agent-client.js";
import type { ServiceRpcError } from "./service.js";
import type { HistoryRequest, HistoryResponse } from "./local-history.js";
import {
  localDaemonCommands,
  ServiceInputError,
  StartTaskPartialFailure,
  StartTaskUsageError,
  type LocalDaemonHandlers,
  type SendCommandPayload,
  type StartParticipant,
  type StartTaskCommandPayload,
  type StartTaskCommandResult,
} from "./local-daemon-rpc.js";

type AgentCallableRpcs = RpcGroup.Rpcs<typeof agentCallableGroup>;
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
const AGENT_LOOKUP_PAGE_SIZE = 100;
const AGENT_LOOKUP_MAX_PAGES = 20;

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

function lookupAgentsByNames(
  call: ServiceCall,
  names: readonly string[],
): Effect.Effect<ResultOf<typeof agentsList>, ServiceRpcError> {
  return Effect.gen(function* () {
    const wanted = new Set(names);
    const agents: Array<ResultOf<typeof agentsList>["agents"][number]> = [];
    let cursor: ListCursor | undefined = undefined;
    for (let page = 0; page < AGENT_LOOKUP_MAX_PAGES; page++) {
      const result: ResultOf<typeof agentsList> = yield* call(
        agentsList.name,
        cursor === undefined
          ? { limit: AGENT_LOOKUP_PAGE_SIZE }
          : { limit: AGENT_LOOKUP_PAGE_SIZE, cursor },
      );
      const matchedAgents = result.agents.filter((agent) =>
        wanted.has(agent.name),
      );
      agents.push(...matchedAgents);
      for (const agent of matchedAgents) {
        wanted.delete(agent.name);
      }
      if (wanted.size === 0 || result.nextCursor === undefined) {
        return { agents };
      }
      cursor = result.nextCursor;
    }
    return { agents };
  });
}

function handleSendCommand(
  call: ServiceCall,
  params: SendCommandPayload,
): Effect.Effect<{ readonly messageId: MessageId }, ServiceRpcError> {
  return call(messagesSend.name, {
    taskId: params.target.taskId,
    conversationId: params.target.conversationId,
    parts: [{ type: "text", text: params.message }],
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
      const result = yield* lookupAgentsByNames(call, names);
      for (const agent of result.agents) {
        if (!byName.has(agent.name)) {
          byName.set(agent.name, agent.id);
        }
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
      const result: ResultOf<typeof conversationList> = yield* call(
        conversationList.name,
        {
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        },
      );
      const hit = result.items.find((item) => item.taskId === taskId);
      if (hit !== undefined) {
        return hit.conversation.id;
      }
      if (result.nextCursor === undefined) {
        return null;
      }
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
    call(messagesSend.name, {
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
  if (params.message === undefined) {
    return Effect.succeed(undefined);
  }
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
    const result = yield* call(taskRequest.name, {
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

/**
 * Creates local daemon handlers.
 * @param root0 Value supplied to the operation.
 * @param root0.handleHistoryRequest Value supplied to the operation.
 * @param root0.call Value supplied to the operation.
 * @param root0.conversationCount Value supplied to the operation.
 * @param root0.connected Value supplied to the operation.
 * @param root0.ownAgentId Value supplied to the operation.
 * @returns The created local daemon handlers.
 */
export function makeLocalDaemonHandlers({
  ownAgentId,
  connected,
  conversationCount,
  call,
  handleHistoryRequest,
}: LocalDaemonHandlerOptions): LocalDaemonHandlers {
  return {
    [localDaemonCommands.status]: () =>
      Effect.succeed({
        agentId: ownAgentId,
        connected,
        conversations: conversationCount(),
      }),
    [localDaemonCommands.history]: handleHistoryRequest,
    [localDaemonCommands.agentsList]: (params) =>
      call(
        agentsList.name,
        params.limit === undefined ? {} : { limit: params.limit },
      ),
    [localDaemonCommands.agentsSearch]: (params) =>
      lookupAgentsByNames(call, params.names),
    [localDaemonCommands.messagesList]: (params) =>
      call(messagesList.name, {
        taskId: params.taskId,
        conversationId: params.conversationId,
        ...(params.limit === undefined ? {} : { limit: params.limit }),
      }),
    [localDaemonCommands.send]: (params) => handleSendCommand(call, params),
    [localDaemonCommands.startTask]: (params) =>
      handleStartTaskCommand(call, params),
  };
}
