/* eslint-disable @typescript-eslint/no-magic-numbers --
   per-class wire error codes (replaces the central WIRE_CODES table). */
import { Data } from "effect";
import { Type, type Static } from "@sinclair/typebox";
import {
  stringEnum,
  dateTimeStringSchema,
  brandedId,
} from "../schema-primitives.js";
import { AgentId } from "../identity/agents.js";
import { defineRpc, defineNotification } from "../transport/method.js";
import {
  registerErrorClass,
  type RpcErrorPayload,
} from "../transport/wire-errors.js";
import {
  ConversationId,
  ConversationTypeEnum,
  agentParticipantRefSchema,
  conversationSchema,
  MessageId,
} from "./conversations.js";
import { messagePartsSchema, messageSchema } from "./messages.js";

const DateTimeString = dateTimeStringSchema();
const AgentParticipantRefSchema = agentParticipantRefSchema();
const ConversationSchema = conversationSchema();
const MessagePartsSchema = messagePartsSchema();
const MessageSchema = messageSchema();

export const TaskId = brandedId("TaskId");
export type TaskId = Static<typeof TaskId>;

export class TaskClosedError extends Data.TaggedError(
  "TaskClosed",
)<RpcErrorPayload> {
  static readonly code = -32020;
  static readonly message = "Task is closed";
}
registerErrorClass(TaskClosedError);

export class HookBlockedError extends Data.TaggedError(
  "HookBlocked",
)<RpcErrorPayload> {
  static readonly code = -32019;
  static readonly message = "Hook blocked the dispatch";
}
registerErrorClass(HookBlockedError);

/** Logical time frontier per delivery domain (usually a conversation):
 * monotonic `epoch` + per-participant observed counts in `vector`. */
const LogicalClockSchema = Type.Object(
  {
    domainId: Type.String({ minLength: 1 }),
    epoch: Type.Integer({ minimum: 0 }),
    vector: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false },
);

export type LogicalClock = Static<typeof LogicalClockSchema>;

export function logicalClockSchema(): typeof LogicalClockSchema {
  return LogicalClockSchema;
}

const TmTypeEnum = stringEnum(["self", "default-dm", "default-group"]);
export type TmType = (typeof TmTypeEnum)["static"];

// Mirrors the `task_status` DB enum.
const TaskStatusEnum = stringEnum(["waiting", "active", "failed", "closed"]);

export type TaskStatus = Static<typeof TaskStatusEnum>;

const TaskSchema = Type.Object(
  {
    id: TaskId,
    appId: Type.Union([Type.String(), Type.Null()]),
    initiatorAgentId: AgentId,
    status: TaskStatusEnum,
    // The persisted task output exposes `tmEndpointAddress` (a branded
    // `EndpointAddress` string). The public `tasks/create` request does
    // NOT take an address directly; it takes a `tmType` enum and the
    // server derives the address (Phase 9b R16, PR #461).
    tmEndpointAddress: Type.String({ minLength: 1 }),
    startedAt: Type.Union([DateTimeString, Type.Null()]),
    endedAt: Type.Union([DateTimeString, Type.Null()]),
    createdAt: DateTimeString,
  },
  { additionalProperties: false },
);

export type Task = Static<typeof TaskSchema>;

// `admittedAt = null` ⇒ invited but not yet admitted.
const TaskParticipantSchema = Type.Object(
  {
    taskId: TaskId,
    agentId: AgentId,
    admittedAt: Type.Union([DateTimeString, Type.Null()]),
  },
  { additionalProperties: false },
);

export type TaskParticipant = Static<typeof TaskParticipantSchema>;

export const TasksCreate = defineRpc({
  name: "tasks/create",
  params: Type.Object(
    {
      appId: Type.Optional(Type.String()),
      invitedAgentIds: Type.Optional(Type.Array(AgentId)),
      tmType: TmTypeEnum,
    },
    { additionalProperties: false },
  ),
  result: Type.Object({ task: TaskSchema }, { additionalProperties: false }),
});

export const TasksGet = defineRpc({
  name: "tasks/get",
  params: Type.Object({ taskId: TaskId }, { additionalProperties: false }),
  result: Type.Object(
    {
      task: TaskSchema,
      participants: Type.Array(TaskParticipantSchema),
    },
    { additionalProperties: false },
  ),
});

export const TasksList = defineRpc({
  name: "tasks/list",
  params: Type.Object(
    {
      appId: Type.Optional(Type.String()),
      status: Type.Optional(TaskStatusEnum),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { tasks: Type.Array(TaskSchema) },
    { additionalProperties: false },
  ),
});

export const TasksClose = defineRpc({
  name: "tasks/close",
  params: Type.Object({ taskId: TaskId }, { additionalProperties: false }),
  result: Type.Object({ task: TaskSchema }, { additionalProperties: false }),
});

export const TasksCreateConversation = defineRpc({
  name: "tasks/createConversation",
  params: Type.Object(
    {
      taskId: TaskId,
      type: ConversationTypeEnum,
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      participants: Type.Array(AgentParticipantRefSchema, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { conversation: ConversationSchema },
    { additionalProperties: false },
  ),
});

export const TasksCloseConversation = defineRpc({
  name: "tasks/closeConversation",
  params: Type.Object(
    {
      taskId: TaskId,
      conversationId: ConversationId,
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export const TasksAddParticipant = defineRpc({
  name: "tasks/addParticipant",
  params: Type.Object(
    {
      taskId: TaskId,
      agentId: AgentId,
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { participant: TaskParticipantSchema },
    { additionalProperties: false },
  ),
});

export const TasksRemoveParticipant = defineRpc({
  name: "tasks/removeParticipant",
  params: Type.Object(
    {
      taskId: TaskId,
      agentId: AgentId,
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export const TasksStoreMessage = defineRpc({
  name: "tasks/storeMessage",
  params: Type.Object(
    {
      taskId: TaskId,
      conversationId: ConversationId,
      senderAgentId: AgentId,
      parts: MessagePartsSchema,
      replyToId: Type.Optional(MessageId),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { message: MessageSchema },
    { additionalProperties: false },
  ),
});

export const TasksGetMessages = defineRpc({
  name: "tasks/getMessages",
  params: Type.Object(
    {
      taskId: TaskId,
      conversationId: ConversationId,
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      messages: Type.Array(MessageSchema),
      hasMore: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
});

export const TasksGetMessagesSince = defineRpc({
  name: "tasks/getMessagesSince",
  params: Type.Object(
    {
      taskId: TaskId,
      conversationId: ConversationId,
      sinceSeq: Type.String({
        description: "Snowflake seq cursor (string-encoded BIGINT)",
      }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      messages: Type.Array(MessageSchema),
      hasMore: Type.Boolean(),
    },
    { additionalProperties: false },
  ),
});

const TaskFailedNotificationSchema = Type.Object(
  { taskId: TaskId },
  { additionalProperties: false },
);

export const TaskFailedNotificationDefinition = defineNotification({
  name: "task/failed",
  params: TaskFailedNotificationSchema,
});
