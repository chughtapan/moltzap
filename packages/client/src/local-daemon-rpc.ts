import { Rpc, RpcGroup } from "@effect/rpc";
import { Effect, ParseResult, Schema } from "effect";
import type * as SchemaAST from "effect/SchemaAST";
import {
  AgentId,
  AgentsList,
  AgentsLookupByName,
  ContactId,
  ContactsAccept,
  ContactsAdd,
  ContactsList,
  UserId,
} from "@moltzap/protocol/identity";
import { agentCallableMethods } from "@moltzap/protocol/rpc-method-groups";
import { AppId, TaskId } from "@moltzap/protocol/task";
import { ConversationId, MessageId } from "@moltzap/protocol/conversation";
import { MessagesList } from "@moltzap/protocol/message";
import {
  NotConnectedError,
  RpcTimeoutError,
} from "@moltzap/protocol/transport";
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
  agentId: Schema.optional(AgentId),
  connected: Schema.Boolean,
  conversations: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});
const PageLimit = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(1),
  Schema.lessThanOrEqualTo(MAX_PAGE_LIMIT),
);

export const AppIdV4 = AppId.pipe(
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
  taskId: TaskId,
  conversationId: ConversationId,
});

export const SendTarget = Schema.transformOrFail(
  Schema.String,
  SendTargetParts,
  {
    strict: true,
    decode: (raw, _options, ast) => {
      if (!raw.startsWith(SEND_TARGET_PREFIX)) {
        return parseStringIssue(
          ast,
          raw,
          `expected ${SEND_TARGET_PREFIX}<taskId>:<conversationId>`,
        );
      }
      const rest = raw.slice(SEND_TARGET_PREFIX.length);
      const parts = rest.split(":");
      if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
        return parseStringIssue(
          ast,
          raw,
          `expected ${SEND_TARGET_PREFIX}<taskId>:<conversationId>`,
        );
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
  id: AgentId,
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
      if (!raw.startsWith(PARTICIPANT_PREFIX)) {
        return parseStringIssue(
          ast,
          raw,
          `expected ${PARTICIPANT_PREFIX}<name-or-agent-id>`,
        );
      }
      const rest = raw.slice(PARTICIPANT_PREFIX.length);
      if (rest.length === 0) {
        return parseStringIssue(
          ast,
          raw,
          `expected ${PARTICIPANT_PREFIX}<name-or-agent-id>`,
        );
      }
      if (UUID_V4_RE.test(rest)) {
        return Schema.decodeUnknown(AgentId)(rest).pipe(
          Effect.map((id) => ({ kind: "id" as const, id })),
          Effect.mapError(
            () =>
              new ParseResult.Type(
                ast,
                raw,
                `expected ${PARTICIPANT_PREFIX}<name-or-agent-id>`,
              ),
          ),
        );
      }
      return Schema.decodeUnknown(AgentName)(rest).pipe(
        Effect.map((name) => ({
          kind: "name" as const,
          token: raw,
          name,
        })),
        Effect.mapError(
          () =>
            new ParseResult.Type(
              ast,
              raw,
              `expected ${PARTICIPANT_PREFIX}<name-or-agent-id>`,
            ),
        ),
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
  Status: "daemon/status",
  History: "daemon/history",
  AgentsList: "cli/agents/list",
  AgentsLookup: "cli/agents/lookup",
  ContactsList: "cli/contacts/list",
  ContactsAdd: "cli/contacts/add",
  ContactsAccept: "cli/contacts/accept",
  MessagesList: "cli/messages/list",
  Send: "cli/send",
  StartTask: "cli/start-task",
} as const;

const AgentsListCommandPayload = Schema.Struct({
  limit: Schema.optional(PageLimit),
});

const AgentsLookupCommandPayload = Schema.Struct({
  names: Schema.Array(AgentName).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_NAME_LOOKUP_BATCH),
  ),
});

const ContactsListCommandPayload = EmptyPayload;

const ContactsAddCommandPayload = Schema.Struct({
  userId: UserId,
});

const ContactsAcceptCommandPayload = Schema.Struct({
  contactId: ContactId,
});

const MessagesListCommandPayload = Schema.Struct({
  taskId: TaskId,
  conversationId: ConversationId,
  limit: Schema.optional(PageLimit),
});

const SendCommandPayload = Schema.Struct({
  target: SendTarget,
  message: Schema.String.pipe(Schema.minLength(1)),
  replyToId: Schema.optional(MessageId),
});
export type SendCommandPayload = Schema.Schema.Type<typeof SendCommandPayload>;

const SendCommandResult = Schema.Struct({
  messageId: MessageId,
});

const StartTaskCommandPayload = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)),
  participants: Schema.Array(StartParticipant),
  message: Schema.optional(Schema.String),
  appId: Schema.optional(AppIdV4),
});

const StartTaskCommandResult = Schema.Struct({
  taskId: TaskId,
  conversationId: ConversationId,
  reusedConversation: Schema.Boolean,
  sentMessageId: Schema.optional(MessageId),
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
    taskId: TaskId,
    conversationId: ConversationId,
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

export class LocalDaemonRpcs extends RpcGroup.make(
  Rpc.make(LocalDaemonCommands.Status, {
    payload: EmptyPayload,
    success: LocalDaemonStatusResultSchema,
    error: LocalDaemonErrorSchema,
  }),
  Rpc.make(LocalDaemonCommands.History, {
    payload: historyRequestSchema(),
    success: historyResponseSchema(),
    error: LocalDaemonErrorSchema,
  }),
  Rpc.make(LocalDaemonCommands.AgentsList, {
    payload: AgentsListCommandPayload,
    success: AgentsList.resultSchema,
    error: LocalDaemonErrorSchema,
  }),
  Rpc.make(LocalDaemonCommands.AgentsLookup, {
    payload: AgentsLookupCommandPayload,
    success: AgentsLookupByName.resultSchema,
    error: LocalDaemonErrorSchema,
  }),
  Rpc.make(LocalDaemonCommands.ContactsList, {
    payload: ContactsListCommandPayload,
    success: ContactsList.resultSchema,
    error: LocalDaemonErrorSchema,
  }),
  Rpc.make(LocalDaemonCommands.ContactsAdd, {
    payload: ContactsAddCommandPayload,
    success: ContactsAdd.resultSchema,
    error: LocalDaemonErrorSchema,
  }),
  Rpc.make(LocalDaemonCommands.ContactsAccept, {
    payload: ContactsAcceptCommandPayload,
    success: ContactsAccept.resultSchema,
    error: LocalDaemonErrorSchema,
  }),
  Rpc.make(LocalDaemonCommands.MessagesList, {
    payload: MessagesListCommandPayload,
    success: MessagesList.resultSchema,
    error: LocalDaemonErrorSchema,
  }),
  Rpc.make(LocalDaemonCommands.Send, {
    payload: SendCommandPayload,
    success: SendCommandResult,
    error: LocalDaemonErrorSchema,
  }),
  Rpc.make(LocalDaemonCommands.StartTask, {
    payload: StartTaskCommandPayload,
    success: StartTaskCommandResult,
    error: LocalDaemonErrorSchema,
  }),
) {}

export type LocalDaemonHandlers = RpcGroup.HandlersFrom<
  RpcGroup.Rpcs<typeof LocalDaemonRpcs>
>;
