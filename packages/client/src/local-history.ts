import { agentId } from "@moltzap/protocol/identity";
import { conversationId, messageId } from "@moltzap/protocol/conversation";
import type { Message } from "@moltzap/protocol/message";
import { HashMap, Option, Schema } from "effect";
import { renderPart } from "./message-rendering.js";

const DEFAULT_HISTORY_LIMIT = 10;
const MAX_HISTORY_LIMIT = 100;

const historyLimit = Schema.Number.pipe(
  Schema.int(),
  Schema.between(1, MAX_HISTORY_LIMIT),
);

const historyRequestSchemaValue = Schema.Struct({
  conversationId: conversationId,
  limit: Schema.optionalWith(historyLimit, {
    default: () => DEFAULT_HISTORY_LIMIT,
  }),
  sessionKey: Schema.optional(Schema.String),
});

const historyMessageSummarySchema = Schema.Struct({
  id: messageId,
  senderId: agentId,
  senderName: Schema.String,
  isOwn: Schema.Boolean,
  text: Schema.String,
  createdAt: Schema.String,
  isNew: Schema.Boolean,
});

const conversationMetadataSchema = Schema.Struct({
  tags: Schema.optional(
    Schema.Array(
      Schema.Record({
        key: Schema.String,
        value: Schema.String,
      }),
    ),
  ),
});

const historyConversationMetaSchema = Schema.Struct({
  id: conversationId,
  name: Schema.optional(Schema.String),
  createdBy: agentId,
  metadata: Schema.optional(conversationMetadataSchema),
  lastMessageTimestamp: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const historyResponseSchemaValue = Schema.Struct({
  messages: Schema.Array(historyMessageSummarySchema),
  conversationMeta: Schema.optional(historyConversationMetaSchema),
  newCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});

/** Represents history request values. */
export type HistoryRequest = Schema.Schema.Type<
  typeof historyRequestSchemaValue
>;
/** Represents history message summary values. */
export type HistoryMessageSummary = Schema.Schema.Type<
  typeof historyMessageSummarySchema
>;
/** Represents history response values. */
export type HistoryResponse = Schema.Schema.Type<
  typeof historyResponseSchemaValue
>;

/**
 * Executes the history request schema operation.
 * @returns The history request schema result.
 */
export function historyRequestSchema(): typeof historyRequestSchemaValue {
  return historyRequestSchemaValue;
}

/**
 * Executes the history response schema operation.
 * @returns The history response schema result.
 */
export function historyResponseSchema(): typeof historyResponseSchemaValue {
  return historyResponseSchemaValue;
}

interface FormatHistoryMessageOptions {
  readonly agentNames: HashMap.HashMap<string, string>;
  readonly ownAgentId?: string;
  readonly lastReadIds: ReadonlySet<string>;
  readonly hasSessionKey: boolean;
}

/**
 * Formats history message.
 * @param message Value supplied to the operation.
 * @param options Options that control the operation.
 * @returns The format history message result.
 */
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

/**
 * Executes the last read ids for session operation.
 * @param lastReadMap Value supplied to the operation.
 * @param request Value supplied to the operation.
 * @returns The last read ids for session result.
 */
export function lastReadIdsForSession(
  lastReadMap: HashMap.HashMap<
    string,
    HashMap.HashMap<string, ReadonlySet<string>>
  >,
  request: HistoryRequest,
): ReadonlySet<string> {
  if (request.sessionKey === undefined) {
    return new Set<string>();
  }
  return Option.getOrElse(
    Option.flatMap(HashMap.get(lastReadMap, request.sessionKey), (perConv) =>
      HashMap.get(perConv, request.conversationId),
    ),
    () =>
      /* Safe because the surrounding invariant establishes this asserted shape. */ new Set<string>() as ReadonlySet<string>,
  );
}
