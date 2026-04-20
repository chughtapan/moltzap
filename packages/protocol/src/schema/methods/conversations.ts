import { Type } from "@sinclair/typebox";
import { stringEnum, DateTimeString } from "../../helpers.js";
import { ConversationId } from "../primitives.js";
import {
  ConversationSchema,
  ConversationTypeEnum,
  ConversationParticipantSchema,
  ConversationSummarySchema,
} from "../conversations.js";
import { defineRpc } from "../../rpc.js";

const AgentParticipantSchema = Type.Object(
  {
    type: stringEnum(["agent"]),
    id: Type.String({ format: "uuid" }),
  },
  { additionalProperties: false },
);

// ---------------------------------------------------------------------------
// RpcDefinition manifests.
// ---------------------------------------------------------------------------

export const ConversationsCreate = defineRpc({
  name: "conversations/create",
  params: Type.Object(
    {
      type: ConversationTypeEnum,
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      participants: Type.Array(AgentParticipantSchema, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    { conversation: ConversationSchema },
    { additionalProperties: false },
  ),
});

export const ConversationsList = defineRpc({
  name: "conversations/list",
  params: Type.Object(
    {
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      cursor: Type.Optional(Type.String()),
      archived: Type.Optional(stringEnum(["exclude", "include", "only"])),
    },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      conversations: Type.Array(ConversationSummarySchema),
      cursor: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
});

export const ConversationsGet = defineRpc({
  name: "conversations/get",
  params: Type.Object(
    { conversationId: ConversationId },
    { additionalProperties: false },
  ),
  result: Type.Object(
    {
      conversation: ConversationSchema,
      participants: Type.Array(ConversationParticipantSchema),
    },
    { additionalProperties: false },
  ),
});

export const ConversationsUpdate = defineRpc({
  name: "conversations/update",
  params: Type.Object(
    {
      conversationId: ConversationId,
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export const ConversationsMute = defineRpc({
  name: "conversations/mute",
  params: Type.Object(
    {
      conversationId: ConversationId,
      until: Type.Optional(DateTimeString),
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export const ConversationsUnmute = defineRpc({
  name: "conversations/unmute",
  params: Type.Object(
    { conversationId: ConversationId },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export const ConversationsAddParticipant = defineRpc({
  name: "conversations/addParticipant",
  params: Type.Object(
    {
      conversationId: ConversationId,
      participant: AgentParticipantSchema,
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export const ConversationsRemoveParticipant = defineRpc({
  name: "conversations/removeParticipant",
  params: Type.Object(
    {
      conversationId: ConversationId,
      participant: AgentParticipantSchema,
    },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export const ConversationsLeave = defineRpc({
  name: "conversations/leave",
  params: Type.Object(
    { conversationId: ConversationId },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export const ConversationsArchive = defineRpc({
  name: "conversations/archive",
  params: Type.Object(
    { conversationId: ConversationId },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});

export const ConversationsUnarchive = defineRpc({
  name: "conversations/unarchive",
  params: Type.Object(
    { conversationId: ConversationId },
    { additionalProperties: false },
  ),
  result: Type.Object({}, { additionalProperties: false }),
});
