import type { RpcGroup } from "@effect/rpc";
import { Effect, Either } from "effect";
import {
  agentsList,
  DEFAULT_APP_ID,
  type AgentId,
} from "@moltzap/protocol/identity";
import type { agentCallableGroup } from "@moltzap/protocol/socket/catalog";
import {
  agentConversationCreate,
  type ConversationId,
  type MessageId,
} from "@moltzap/protocol/conversation";
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
  StartPartialFailure,
  StartUsageError,
  type LocalDaemonHandlers,
  type SendCommandPayload,
  type StartCommandPayload,
  type StartCommandResult,
  type StartParticipant,
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
  readonly conversationId: ConversationId;
  readonly text: string;
}

interface OptionalStartMessageInput {
  readonly call: ServiceCall;
  readonly params: StartCommandPayload;
  readonly conversationId: ConversationId;
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

function resolveStartParticipantIds(
  participants: readonly StartParticipant[],
  byName: ReadonlyMap<string, AgentId>,
): Effect.Effect<readonly AgentId[], StartUsageError> {
  return Effect.gen(function* () {
    const resolved: AgentId[] = [];
    for (const entry of participants) {
      if (entry.kind === "id") {
        resolved.push(entry.id);
        continue;
      }
      const id = byName.get(entry.name);
      if (id === undefined) {
        return yield* new StartUsageError({
          message: `Cannot resolve "${entry.token}": not-found`,
        });
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
    conversationId: params.target.conversationId,
    parts: [{ type: "text", text: params.message }],
    ...(params.target.taskId === undefined
      ? {}
      : { taskId: params.target.taskId }),
  }).pipe(Effect.map((result) => ({ messageId: result.message.id })));
}

function resolveStartParticipants(
  call: ServiceCall,
  participants: readonly StartParticipant[],
): Effect.Effect<readonly AgentId[], StartUsageError | ServiceRpcError> {
  return Effect.gen(function* () {
    const names = startParticipantNames(participants);
    if (names.length > MAX_START_PARTICIPANT_LOOKUP_NAMES) {
      return yield* new StartUsageError({
        message: `Too many distinct agent names: ${names.length} (max ${MAX_START_PARTICIPANT_LOOKUP_NAMES})`,
      });
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

function sendStartMessage({
  call,
  conversationId,
  text,
}: StartMessageInput): Effect.Effect<
  MessageId,
  StartPartialFailure | ServiceRpcError
> {
  return Effect.either(
    call(messagesSend.name, {
      conversationId,
      parts: [{ type: "text", text }],
    }),
  ).pipe(
    Effect.flatMap((outcome) =>
      Either.match(outcome, {
        onRight: (result) => Effect.succeed(result.message.id),
        onLeft: (error) =>
          Effect.fail(
            new StartPartialFailure({
              conversationId,
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
  conversationId,
}: OptionalStartMessageInput): Effect.Effect<
  MessageId | undefined,
  StartPartialFailure | ServiceRpcError
> {
  if (params.message === undefined) {
    return Effect.void.pipe(Effect.as(undefined));
  }
  return sendStartMessage({
    call,
    conversationId,
    text: params.message,
  });
}

function handleStartCommand(
  call: ServiceCall,
  params: StartCommandPayload,
): Effect.Effect<
  StartCommandResult,
  StartUsageError | StartPartialFailure | ServiceRpcError
> {
  return Effect.gen(function* () {
    const appId = params.appId ?? DEFAULT_APP_ID;
    const participants = yield* resolveStartParticipants(
      call,
      params.participants,
    );
    if (participants.length === 0) {
      return yield* new StartUsageError({
        message: "A conversation needs at least one other participant",
      });
    }
    const created = yield* call(agentConversationCreate.name, {
      appId,
      name: params.name,
      participants,
    });
    const conversationId = created.conversation.id;
    const sentMessageId = yield* sendOptionalStartMessage({
      call,
      params,
      conversationId,
    });
    return {
      conversationId,
      ...(sentMessageId === undefined ? {} : { sentMessageId }),
    };
  }).pipe(Effect.withSpan("MoltZapService.handleStartCommand"));
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
        conversationId: params.conversationId,
        ...(params.limit === undefined ? {} : { limit: params.limit }),
      }),
    [localDaemonCommands.send]: (params) => handleSendCommand(call, params),
    [localDaemonCommands.start]: (params) => handleStartCommand(call, params),
  };
}
