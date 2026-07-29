import { Rpc, RpcGroup } from "@effect/rpc";
import { Effect, ParseResult, Schema } from "effect";
import type * as SchemaAST from "effect/SchemaAST";
import {
  agentId,
  agentsList,
  contactId,
  contactsAccept,
  contactsAdd,
  contactsList,
  userId,
} from "@moltzap/protocol/identity";
import { agentCallableMethods } from "@moltzap/protocol/socket/catalog";
import { appId, taskId } from "@moltzap/protocol/task";
import { conversationId, messageId } from "@moltzap/protocol/conversation";
import { messagesList } from "@moltzap/protocol/message";
import { NotConnectedError, RpcTimeoutError } from "@moltzap/protocol/rpc";
import {
  historyRequestSchema,
  historyResponseSchema,
} from "./local-history.js";

const MAX_PAGE_LIMIT = 200;
const MAX_NAME_LOOKUP_BATCH = 100;
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEND_TARGET_PREFIX = "task:";
const PARTICIPANT_PREFIX = "agent:";

const EmptyPayload = Schema.Struct({});
const LocalDaemonStatusResultSchema = Schema.Struct({
  agentId: Schema.optional(agentId),
  connected: Schema.Boolean,
  conversations: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});
const PageLimit = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(1),
  Schema.lessThanOrEqualTo(MAX_PAGE_LIMIT),
);

export const AppIdV4 = appId.pipe(
  Schema.filter(
    (value) =>
      (typeof value === "string" && UUID_V4_RE.test(value)) ||
      "must be a UUID v4",
  ),
);
export type AppIdV4 = Schema.Schema.Type<typeof AppIdV4>;

const parseStringIssue = (
  ast: SchemaAST.Transformation,
  actual: unknown,
  message: string,
): Effect.Effect<never, ParseResult.ParseIssue, never> =>
  Effect.fail(new ParseResult.Type(ast, actual, message));

const SendTargetParts = Schema.Struct({
  taskId: taskId,
  conversationId: conversationId,
});

export const SendTarget = Schema.transformOrFail(
  Schema.String,
  SendTargetParts,
  {
    strict: true,
    decode: (raw, _options, ast) => {
      const expected = `expected ${SEND_TARGET_PREFIX}<taskId>:<conversationId>`;
      if (!raw.startsWith(SEND_TARGET_PREFIX)) {
        return parseStringIssue(ast, raw, expected);
      }
      const rest = raw.slice(SEND_TARGET_PREFIX.length);
      const parts = rest.split(":");
      if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
        return parseStringIssue(ast, raw, expected);
      }
      return Effect.succeed({
        taskId: parts[0]!,
        conversationId: parts[1]!,
      });
    },
    encode: (target) =>
      Effect.succeed(
        `${SEND_TARGET_PREFIX}${target.taskId}:${target.conversationId}`,
      ),
  },
);
export type SendTarget = Schema.Schema.Type<typeof SendTarget>;

const AgentName = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(32));

const StartParticipantById = Schema.Struct({
  kind: Schema.Literal("id"),
  id: agentId,
});
const StartParticipantByName = Schema.Struct({
  kind: Schema.Literal("name"),
  token: Schema.String,
  name: AgentName,
});
const StartParticipantParts = Schema.Union(
  StartParticipantById,
  StartParticipantByName,
);

export const StartParticipant = Schema.transformOrFail(
  Schema.String,
  StartParticipantParts,
  {
    strict: true,
    decode: (raw, _options, ast) => {
      const expected = `expected ${PARTICIPANT_PREFIX}<name-or-agent-id>`;
      if (!raw.startsWith(PARTICIPANT_PREFIX)) {
        return parseStringIssue(ast, raw, expected);
      }
      const rest = raw.slice(PARTICIPANT_PREFIX.length);
      if (rest.length === 0) {
        return parseStringIssue(ast, raw, expected);
      }
      if (UUID_V4_RE.test(rest)) {
        return Schema.decodeUnknown(agentId)(rest).pipe(
          Effect.map((id) => ({ kind: "id" as const, id })),
          Effect.mapError(() => new ParseResult.Type(ast, raw, expected)),
        );
      }
      return Schema.decodeUnknown(AgentName)(rest).pipe(
        Effect.map((name) => ({
          kind: "name" as const,
          token: raw,
          name,
        })),
        Effect.mapError(() => new ParseResult.Type(ast, raw, expected)),
      );
    },
    encode: (participant) =>
      Effect.succeed(
        participant.kind === "id"
          ? `${PARTICIPANT_PREFIX}${participant.id}`
          : participant.token,
      ),
  },
);
export type StartParticipant = Schema.Schema.Type<typeof StartParticipant>;

export const LocalDaemonCommands = {
  status: "daemon/status",
  history: "daemon/history",
  agentsList: "cli/agents/list",
  agentsSearch: "cli/agents/search",
  contactsList: "cli/contacts/list",
  contactsAdd: "cli/contacts/add",
  contactsAccept: "cli/contacts/accept",
  messagesList: "cli/messages/list",
  send: "cli/send",
  startTask: "cli/start-task",
} as const;

const AgentsListCommandPayload = Schema.Struct({
  limit: Schema.optional(PageLimit),
});

const AgentsSearchCommandPayload = Schema.Struct({
  names: Schema.Array(AgentName).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_NAME_LOOKUP_BATCH),
  ),
});

const ContactsListCommandPayload = EmptyPayload;

const ContactsAddCommandPayload = Schema.Struct({
  userId: userId,
});

const ContactsAcceptCommandPayload = Schema.Struct({
  contactId: contactId,
});

const MessagesListCommandPayload = Schema.Struct({
  taskId: taskId,
  conversationId: conversationId,
  limit: Schema.optional(PageLimit),
});

const SendCommandPayload = Schema.Struct({
  target: SendTarget,
  message: Schema.String.pipe(Schema.minLength(1)),
  replyToId: Schema.optional(messageId),
});
export type SendCommandPayload = Schema.Schema.Type<typeof SendCommandPayload>;

const SendCommandResult = Schema.Struct({
  messageId: messageId,
});

const StartTaskCommandPayload = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)),
  participants: Schema.Array(StartParticipant),
  message: Schema.optional(Schema.String),
  appId: Schema.optional(AppIdV4),
});

const StartTaskCommandResult = Schema.Struct({
  taskId: taskId,
  conversationId: conversationId,
  reusedConversation: Schema.Boolean,
  sentMessageId: Schema.optional(messageId),
});

export type StartTaskCommandPayload = Schema.Schema.Type<
  typeof StartTaskCommandPayload
>;
export type StartTaskCommandResult = Schema.Schema.Type<
  typeof StartTaskCommandResult
>;

export class LocalDaemonInputError extends Schema.TaggedError<LocalDaemonInputError>()(
  "LocalDaemonInputError",
  { message: Schema.String },
) {}

export class StartTaskUsageError extends Schema.TaggedError<StartTaskUsageError>()(
  "StartTaskUsageError",
  { message: Schema.String },
) {}

export class StartTaskPartialFailure extends Schema.TaggedError<StartTaskPartialFailure>()(
  "StartTaskPartialFailure",
  {
    taskId: taskId,
    conversationId: conversationId,
    reusedConversation: Schema.Boolean,
    message: Schema.String,
  },
) {}

export class ServiceInputError extends Schema.TaggedError<ServiceInputError>()(
  "ServiceInputError",
  { message: Schema.String },
) {}

const LocalDaemonErrorSchema = Schema.Union(
  LocalDaemonInputError,
  StartTaskUsageError,
  StartTaskPartialFailure,
  ServiceInputError,
  NotConnectedError,
  RpcTimeoutError,
  ...agentCallableMethods.map((definition) => definition.errorSchema),
);

export type LocalDaemonError = Schema.Schema.Type<
  typeof LocalDaemonErrorSchema
>;

export const isLocalDaemonError = Schema.is(LocalDaemonErrorSchema);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const toLocalDaemonError = (error: unknown): LocalDaemonError =>
  isLocalDaemonError(error)
    ? error
    : new LocalDaemonInputError({ message: errorMessage(error) });

export const MessagesListCommandRpc = Rpc.make(
  LocalDaemonCommands.messagesList,
  {
    payload: MessagesListCommandPayload,
    success: messagesList.resultSchema,
    error: LocalDaemonErrorSchema,
  },
);

export const SendCommandRpc = Rpc.make(LocalDaemonCommands.send, {
  payload: SendCommandPayload,
  success: SendCommandResult,
  error: LocalDaemonErrorSchema,
});

export const StartTaskCommandRpc = Rpc.make(LocalDaemonCommands.startTask, {
  payload: StartTaskCommandPayload,
  success: StartTaskCommandResult,
  error: LocalDaemonErrorSchema,
});

export class LocalDaemonRpcs extends RpcGroup.make(
  Rpc.make(LocalDaemonCommands.status, {
    payload: EmptyPayload,
    success: LocalDaemonStatusResultSchema,
    error: LocalDaemonErrorSchema,
  }),
  Rpc.make(LocalDaemonCommands.history, {
    payload: historyRequestSchema(),
    success: historyResponseSchema(),
    error: LocalDaemonErrorSchema,
  }),
  Rpc.make(LocalDaemonCommands.agentsList, {
    payload: AgentsListCommandPayload,
    success: agentsList.resultSchema,
    error: LocalDaemonErrorSchema,
  }),
  Rpc.make(LocalDaemonCommands.agentsSearch, {
    payload: AgentsSearchCommandPayload,
    success: agentsList.resultSchema,
    error: LocalDaemonErrorSchema,
  }),
  Rpc.make(LocalDaemonCommands.contactsList, {
    payload: ContactsListCommandPayload,
    success: contactsList.resultSchema,
    error: LocalDaemonErrorSchema,
  }),
  Rpc.make(LocalDaemonCommands.contactsAdd, {
    payload: ContactsAddCommandPayload,
    success: contactsAdd.resultSchema,
    error: LocalDaemonErrorSchema,
  }),
  Rpc.make(LocalDaemonCommands.contactsAccept, {
    payload: ContactsAcceptCommandPayload,
    success: contactsAccept.resultSchema,
    error: LocalDaemonErrorSchema,
  }),
  MessagesListCommandRpc,
  SendCommandRpc,
  StartTaskCommandRpc,
) {}

export type LocalDaemonHandlers = RpcGroup.HandlersFrom<
  RpcGroup.Rpcs<typeof LocalDaemonRpcs>
>;
