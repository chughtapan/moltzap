import { Type } from "@sinclair/typebox";
import { stringEnum } from "../../helpers.js";
import {
  AgentId,
  ConversationId,
  MessageId,
  TaskId,
} from "../../schema/primitives.js";
import {
  TaskSchema,
  TaskParticipantSchema,
  TaskStatusEnum,
} from "../../schema/tasks.js";
import {
  ConversationSchema,
  ConversationTypeEnum,
} from "../../schema/conversations.js";
import { MessageSchema, PartSchema } from "../../schema/messages.js";
import { defineRpc } from "../../rpc.js";

export const TasksCreate = defineRpc({
  name: "tasks/create",
  params: Type.Object(
    {
      appId: Type.Optional(Type.String()),
      invitedAgentIds: Type.Optional(Type.Array(AgentId)),
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

const TaskConversationParticipantSchema = Type.Object(
  {
    type: stringEnum(["agent"]),
    id: Type.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);

export const TasksCreateConversation = defineRpc({
  name: "tasks/createConversation",
  params: Type.Object(
    {
      taskId: TaskId,
      type: ConversationTypeEnum,
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      participants: Type.Array(TaskConversationParticipantSchema, {
        minItems: 1,
      }),
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
      parts: Type.Array(PartSchema, { minItems: 1, maxItems: 10 }),
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
