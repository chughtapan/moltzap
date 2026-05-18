import type { Message } from "@moltzap/protocol";
import { Data, Effect, HashMap, Option, ParseResult, Schema } from "effect";
import { renderPart } from "./service-helpers.js";

const DEFAULT_HISTORY_LIMIT = 10;
const MAX_HISTORY_LIMIT = 100;

const HistoryLimit = Schema.Number.pipe(
  Schema.int(),
  Schema.between(1, MAX_HISTORY_LIMIT),
);

const HistoryRequestSchema = Schema.Struct({
  conversationId: Schema.String.pipe(Schema.minLength(1)),
  limit: Schema.optionalWith(HistoryLimit, {
    default: () => DEFAULT_HISTORY_LIMIT,
  }),
  sessionKey: Schema.optional(Schema.String),
});

const HistoryMessageSummarySchema = Schema.Struct({
  id: Schema.String,
  senderId: Schema.String,
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
  id: Schema.String,
  type: Schema.Literal("dm", "group"),
  name: Schema.optional(Schema.String),
  createdBy: Schema.String,
  metadata: Schema.optional(ConversationMetadataSchema),
  lastMessageTimestamp: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const HistoryResponseSchema = Schema.Struct({
  messages: Schema.Array(HistoryMessageSummarySchema),
  hasMore: Schema.Boolean,
  conversationMeta: Schema.optional(HistoryConversationMetaSchema),
  newCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
});

export type HistoryRequestInput = Schema.Schema.Encoded<
  typeof HistoryRequestSchema
>;
export type HistoryRequest = Schema.Schema.Type<typeof HistoryRequestSchema>;
export type HistoryMessageSummary = Schema.Schema.Type<
  typeof HistoryMessageSummarySchema
>;
export type HistoryResponse = Schema.Schema.Type<typeof HistoryResponseSchema>;

interface FormatHistoryMessageOptions {
  readonly agentNames: HashMap.HashMap<string, string>;
  readonly ownAgentId: string | undefined;
  readonly lastReadIds: ReadonlySet<string>;
  readonly hasSessionKey: boolean;
}

export class HistoryRequestInputError extends Data.TaggedError(
  "HistoryRequestInputError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

const formatParseError = (error: ParseResult.ParseError): string =>
  ParseResult.TreeFormatter.formatErrorSync(error);

const formatParseCause = (cause: unknown): string =>
  ParseResult.isParseError(cause) ? formatParseError(cause) : String(cause);

const decodeHistoryRequestSync = Schema.decodeUnknownSync(HistoryRequestSchema);

export const decodeHistoryResponse = (
  value: unknown,
): Effect.Effect<HistoryResponse, ParseResult.ParseError> =>
  Schema.decodeUnknown(HistoryResponseSchema)(value);

export function decodeHistoryRequest(
  params: unknown,
): Effect.Effect<HistoryRequest, HistoryRequestInputError> {
  return Effect.try({
    try: () => decodeHistoryRequestSync(params),
    catch: (cause) =>
      new HistoryRequestInputError({
        message: `invalid history request: ${formatParseCause(cause)}`,
        cause,
      }),
  }).pipe(Effect.withSpan("decodeHistoryRequest"));
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
