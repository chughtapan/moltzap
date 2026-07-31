import { Rpc, RpcGroup } from "@effect/rpc";
import { Effect, ParseResult, Schema } from "effect";
import type * as SchemaAST from "effect/SchemaAST";
import { agentId, agentsList, appId } from "@moltzap/protocol/identity";
import { agentCallableMethods } from "@moltzap/protocol/socket/catalog";
import { taskId } from "@moltzap/protocol/task";
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
const CONVERSATION_TARGET_PREFIX = "conv:";
const TASK_TARGET_PREFIX = "task:";
const PARTICIPANT_PREFIX = "agent:";

const emptyPayload = Schema.Struct({});
const localDaemonStatusResultSchema = Schema.Struct({
  agentId: Schema.optional(agentId),
  connected: Schema.Boolean,
  conversations: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});
const pageLimit = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(1),
  Schema.lessThanOrEqualTo(MAX_PAGE_LIMIT),
);

/** Validates and decodes app id v4 values. */
const appIdV4 = appId.pipe(
  Schema.filter(
    (value) =>
      (typeof value === "string" && UUID_V4_RE.test(value)) ||
      "must be a UUID v4",
  ),
);
/** Represents app id v4 values. */
export type AppIdV4 = Schema.Schema.Type<typeof appIdV4>;

const parseStringIssue = (
  ast: SchemaAST.Transformation,
  actual: unknown,
  message: string,
): Effect.Effect<never, ParseResult.ParseIssue> =>
  Effect.fail(new ParseResult.Type(ast, actual, message));

const sendTargetParts = Schema.Struct({
  conversationId: conversationId,
  taskId: Schema.optional(taskId),
});

const SEND_TARGET_EXPECTED = `expected ${CONVERSATION_TARGET_PREFIX}<conversationId> or ${TASK_TARGET_PREFIX}<taskId>:<conversationId>`;

/**
 * A conversation is the whole address. `task:&lt;taskId>:&lt;conversationId>`
 * is also accepted so a caller holding a task label can pass it through; the
 * label rides along to `agent/message/send` untouched and never selects the
 * destination.
 */
export const sendTarget = Schema.transformOrFail(
  Schema.String,
  sendTargetParts,
  {
    strict: true,
    decode: (raw, ...[, ast]) => {
      if (raw.startsWith(CONVERSATION_TARGET_PREFIX)) {
        const rest = raw.slice(CONVERSATION_TARGET_PREFIX.length);
        return rest === "" || rest.includes(":")
          ? parseStringIssue(ast, raw, SEND_TARGET_EXPECTED)
          : Effect.succeed({ conversationId: rest });
      }
      if (!raw.startsWith(TASK_TARGET_PREFIX)) {
        return parseStringIssue(ast, raw, SEND_TARGET_EXPECTED);
      }
      const parts = raw.slice(TASK_TARGET_PREFIX.length).split(":");
      if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
        return parseStringIssue(ast, raw, SEND_TARGET_EXPECTED);
      }
      return Effect.succeed({
        taskId:
          /* Safe because the surrounding invariant establishes this asserted shape. */ parts[0]!,
        conversationId:
          /* Safe because the surrounding invariant establishes this asserted shape. */ parts[1]!,
      });
    },
    encode: (target) =>
      Effect.succeed(
        target.taskId === undefined
          ? `${CONVERSATION_TARGET_PREFIX}${target.conversationId}`
          : `${TASK_TARGET_PREFIX}${target.taskId}:${target.conversationId}`,
      ),
  },
);
/** Represents send target values. */
export type SendTarget = Schema.Schema.Type<typeof sendTarget>;

const agentName = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(32));

const startParticipantById = Schema.Struct({
  kind: Schema.Literal("id"),
  id: agentId,
});
const startParticipantByName = Schema.Struct({
  kind: Schema.Literal("name"),
  token: Schema.String,
  name: agentName,
});
const startParticipantParts = Schema.Union(
  startParticipantById,
  startParticipantByName,
);

/** Validates and decodes start participant values. */
export const startParticipant = Schema.transformOrFail(
  Schema.String,
  startParticipantParts,
  {
    strict: true,
    decode: (raw, ...[, ast]) => {
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
      return Schema.decodeUnknown(agentName)(rest).pipe(
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
/** Represents start participant values. */
export type StartParticipant = Schema.Schema.Type<typeof startParticipant>;

/** Provides the local daemon commands runtime value. */
export const localDaemonCommands = {
  status: "daemon/status",
  history: "daemon/history",
  agentsList: "cli/agents/list",
  agentsSearch: "cli/agents/search",
  messagesList: "cli/messages/list",
  send: "cli/send",
  start: "cli/start",
} as const;

const agentsListCommandPayload = Schema.Struct({
  limit: Schema.optional(pageLimit),
});

const agentsSearchCommandPayload = Schema.Struct({
  names: Schema.Array(agentName).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_NAME_LOOKUP_BATCH),
  ),
});

const messagesListCommandPayload = Schema.Struct({
  conversationId: conversationId,
  limit: Schema.optional(pageLimit),
});

const sendCommandPayload = Schema.Struct({
  target: sendTarget,
  message: Schema.String.pipe(Schema.minLength(1)),
});
/** Represents send command payload values. */
export type SendCommandPayload = Schema.Schema.Type<typeof sendCommandPayload>;

const sendCommandResult = Schema.Struct({
  messageId: messageId,
});

const startCommandPayload = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)),
  participants: Schema.Array(startParticipant),
  message: Schema.optional(Schema.String),
  appId: Schema.optional(appIdV4),
});

const startCommandResult = Schema.Struct({
  conversationId: conversationId,
  sentMessageId: Schema.optional(messageId),
});

/** Represents start command payload values. */
export type StartCommandPayload = Schema.Schema.Type<
  typeof startCommandPayload
>;
/** Represents the result of start command. */
export type StartCommandResult = Schema.Schema.Type<typeof startCommandResult>;

/** Reports local daemon input failures. */
export class LocalDaemonInputError extends Schema.TaggedError<LocalDaemonInputError>()(
  "LocalDaemonInputError",
  { message: Schema.String },
) {}

/** Reports start usage failures. */
export class StartUsageError extends Schema.TaggedError<StartUsageError>()(
  "StartUsageError",
  { message: Schema.String },
) {}

/** The conversation exists but its first message did not send. */
export class StartPartialFailure extends Schema.TaggedError<StartPartialFailure>()(
  "StartPartialFailure",
  {
    conversationId: conversationId,
    message: Schema.String,
  },
) {}

/** Reports service input failures. */
export class ServiceInputError extends Schema.TaggedError<ServiceInputError>()(
  "ServiceInputError",
  { message: Schema.String },
) {}

const localDaemonErrorSchema = Schema.Union(
  LocalDaemonInputError,
  StartUsageError,
  StartPartialFailure,
  ServiceInputError,
  NotConnectedError,
  RpcTimeoutError,
  ...agentCallableMethods.map((definition) => definition.errorSchema),
);

/** Represents local daemon error conditions. */
export type LocalDaemonError = Schema.Schema.Type<
  typeof localDaemonErrorSchema
>;

/** Validates and decodes is local daemon error values. */
export const isLocalDaemonError = Schema.is(localDaemonErrorSchema);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Provides the to local daemon error runtime value.
 * @param error Error to inspect.
 * @returns The to local daemon error result.
 */
export const toLocalDaemonError = (error: unknown): LocalDaemonError =>
  isLocalDaemonError(error)
    ? error
    : new LocalDaemonInputError({ message: errorMessage(error) });

/** Provides the messages list command rpc runtime value. */
export const messagesListCommandRpc = Rpc.make(
  localDaemonCommands.messagesList,
  {
    payload: messagesListCommandPayload,
    success: messagesList.resultSchema,
    error: localDaemonErrorSchema,
  },
);

/** Provides the send command rpc runtime value. */
const sendCommandRpc = Rpc.make(localDaemonCommands.send, {
  payload: sendCommandPayload,
  success: sendCommandResult,
  error: localDaemonErrorSchema,
});

/** Provides the start command rpc runtime value. */
export const startCommandRpc = Rpc.make(localDaemonCommands.start, {
  payload: startCommandPayload,
  success: startCommandResult,
  error: localDaemonErrorSchema,
});

/** Implements local daemon rpcs. */
export class LocalDaemonRpcs extends RpcGroup.make(
  Rpc.make(localDaemonCommands.status, {
    payload: emptyPayload,
    success: localDaemonStatusResultSchema,
    error: localDaemonErrorSchema,
  }),
  Rpc.make(localDaemonCommands.history, {
    payload: historyRequestSchema(),
    success: historyResponseSchema(),
    error: localDaemonErrorSchema,
  }),
  Rpc.make(localDaemonCommands.agentsList, {
    payload: agentsListCommandPayload,
    success: agentsList.resultSchema,
    error: localDaemonErrorSchema,
  }),
  Rpc.make(localDaemonCommands.agentsSearch, {
    payload: agentsSearchCommandPayload,
    success: agentsList.resultSchema,
    error: localDaemonErrorSchema,
  }),
  messagesListCommandRpc,
  sendCommandRpc,
  startCommandRpc,
) {}

/** Represents local daemon handlers values. */
export type LocalDaemonHandlers = RpcGroup.HandlersFrom<
  RpcGroup.Rpcs<typeof LocalDaemonRpcs>
>;
