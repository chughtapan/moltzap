import { agentId } from "@moltzap/protocol/identity";
import { conversationId, messageId } from "@moltzap/protocol/conversation";
import { taskId } from "@moltzap/protocol/task";
import type { Message } from "@moltzap/protocol/message";
import { HashMap, Option, Schema } from "effect";
import { renderPart } from "./message-rendering.js";

const DEFAULT_HISTORY_LIMIT = 10;
const MAX_HISTORY_LIMIT = 100;

const HistoryLimit = Schema.Number.pipe(
  Schema.int(),
  Schema.between(1, MAX_HISTORY_LIMIT),
);

const HistoryRequestSchema = Schema.Struct({
  taskId: taskId,
  conversationId: conversationId,
  limit: Schema.optionalWith(HistoryLimit, {
    default: () => DEFAULT_HISTORY_LIMIT,
  }),
  sessionKey: Schema.optional(Schema.String),
});

const HistoryMessageSummarySchema = Schema.Struct({
  id: messageId,
  senderId: agentId,
  senderName: Schema.String,
  isOwn: Schema.Boolean,
  text: Schema.String,
  createdAt: Schema.String,
  isNew: Schema.Boolean,
});

const ConversationMetadataSchema = Schema.Struct({
  tags: Schema.optional(
    Schema.Array(
      Schema.Record({
        key: Schema.String,
        value: Schema.String,
      }),
    ),
  ),
});

const HistoryConversationMetaSchema = Schema.Struct({
  id: conversationId,
  name: Schema.optional(Schema.String),
  createdBy: agentId,
  metadata: Schema.optional(ConversationMetadataSchema),
  lastMessageTimestamp: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  archivedAt: Schema.optional(Schema.String),
});

const HistoryResponseSchema = Schema.Struct({
  messages: Schema.Array(HistoryMessageSummarySchema),
  conversationMeta: Schema.optional(HistoryConversationMetaSchema),
  newCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});

export type HistoryRequest = Schema.Schema.Type<typeof HistoryRequestSchema>;
export type HistoryMessageSummary = Schema.Schema.Type<
  typeof HistoryMessageSummarySchema
>;
export type HistoryResponse = Schema.Schema.Type<typeof HistoryResponseSchema>;

export function historyRequestSchema(): typeof HistoryRequestSchema {
  return HistoryRequestSchema;
}

export function historyResponseSchema(): typeof HistoryResponseSchema {
  return HistoryResponseSchema;
}

interface FormatHistoryMessageOptions {
  readonly agentNames: HashMap.HashMap<string, string>;
  readonly ownAgentId: string | undefined;
  readonly lastReadIds: ReadonlySet<string>;
  readonly hasSessionKey: boolean;
}

export function formatHistoryMessage(
  message: Message,
  options: FormatHistoryMessageOptions,
): HistoryMessageSummary {
  const senderName = Option.getOrElse(
    HashMap.get(options.agentNames, message.senderId),
    () => message.senderId,
  );
  const isOwn = message.senderId === options.ownAgentId;
  return {
    id: message.id,
    senderId: message.senderId,
    senderName: isOwn ? "you" : senderName,
    isOwn,
    text: message.parts.map(renderPart).join(" "),
    createdAt: message.createdAt,
    isNew: options.hasSessionKey ? !options.lastReadIds.has(message.id) : false,
  };
}

export function lastReadIdsForSession(
  lastReadMap: HashMap.HashMap<
    string,
    HashMap.HashMap<string, ReadonlySet<string>>
  >,
  request: HistoryRequest,
): ReadonlySet<string> {
  if (request.sessionKey === undefined) return new Set<string>();
  return Option.getOrElse(
    Option.flatMap(HashMap.get(lastReadMap, request.sessionKey), (perConv) =>
      HashMap.get(perConv, request.conversationId),
    ),
    () => new Set<string>() as ReadonlySet<string>,
  );
}
