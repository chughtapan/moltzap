import {
  type AnyNotificationDefinition,
  type DecodedNotification,
  type Message,
  type Part,
} from "@moltzap/protocol";
import { Data, Effect, HashMap, Match, Option } from "effect";
import type { ConversationMeta, CrossConversationEntry } from "../service.js";
import { getOr } from "./refs.js";

const DEFAULT_HISTORY_LIMIT = 10;
const MILLISECONDS_PER_MINUTE = 60_000;

export class ServiceInputError extends Data.TaggedError("ServiceInputError")<{
  readonly message: string;
}> {}

export interface HistoryRequest {
  readonly convId: string;
  readonly limit: number;
  readonly sessionKey?: string;
}

interface FormatHistoryMessageOptions {
  readonly agentNames: HashMap.HashMap<string, string>;
  readonly ownAgentId: string | undefined;
  readonly lastReadIds: ReadonlySet<string>;
  readonly hasSessionKey: boolean;
}

export interface HistoryMessageSummary {
  readonly id: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly isOwn: boolean;
  readonly text: string;
  readonly createdAt: string;
  readonly isNew: boolean;
}

export interface CrossConvState {
  readonly messagesMap: HashMap.HashMap<string, ReadonlyArray<Message>>;
  readonly conversationsMap: HashMap.HashMap<string, ConversationMeta>;
  readonly agentNamesMap: HashMap.HashMap<string, string>;
  readonly viewMarkers: HashMap.HashMap<string, string>;
}

export interface ContextCandidate {
  readonly convId: string;
  readonly newMsgs: ReadonlyArray<Message>;
  readonly lastTs: number;
}

interface BuiltContextEntries {
  readonly entries: CrossConversationEntry[];
  readonly pendingAdvances: ReadonlyArray<readonly [string, string]>;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recordOrEmpty = (value: unknown): Record<string, unknown> =>
  isPlainRecord(value) ? value : {};

const recordProperty = (
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined => {
  const value = record[key];
  return isPlainRecord(value) ? value : undefined;
};

const stringProperty = (
  record: Record<string, unknown>,
  key: string,
): string | undefined => {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
};

const serviceInputError = (
  message: string,
): Effect.Effect<never, ServiceInputError> =>
  Effect.fail(new ServiceInputError({ message }));

function parseConversationId(
  params: Record<string, unknown>,
): Effect.Effect<string, ServiceInputError> {
  const value = params.conversationId;
  if (typeof value === "string" && value.length > 0) {
    return Effect.succeed(value);
  }
  return serviceInputError("conversationId is required and must be a string");
}

function parseLimit(
  params: Record<string, unknown>,
): Effect.Effect<number, ServiceInputError> {
  const value = params.limit;
  if (value === undefined) return Effect.succeed(DEFAULT_HISTORY_LIMIT);
  if (typeof value === "number") return Effect.succeed(value);
  return serviceInputError("limit must be a number");
}

function parseSessionKey(
  params: Record<string, unknown>,
): Effect.Effect<string | undefined, ServiceInputError> {
  const value = params.sessionKey;
  if (value === undefined) return Effect.succeed(undefined);
  if (typeof value === "string") return Effect.succeed(value);
  return serviceInputError("sessionKey must be a string");
}

export function parseHistoryRequest(
  params: Record<string, unknown>,
): Effect.Effect<HistoryRequest, ServiceInputError> {
  return Effect.gen(function* () {
    const convId = yield* parseConversationId(params);
    const limit = yield* parseLimit(params);
    const sessionKey = yield* parseSessionKey(params);
    return {
      convId,
      limit,
      ...(sessionKey === undefined ? {} : { sessionKey }),
    };
  }).pipe(Effect.withSpan("parseHistoryRequest"));
}

export const renderPart: (part: Part) => string = Match.type<Part>().pipe(
  Match.discriminatorsExhaustive("type")({
    text: (text) => text.text,
    image: () => "[image]",
    file: (file) => `[file: ${file.name}]`,
  }),
);

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
      HashMap.get(perConv, request.convId),
    ),
    () => new Set<string>() as ReadonlySet<string>,
  );
}

export function newMessagesForConversation(
  convId: string,
  messages: ReadonlyArray<Message>,
  viewMarkers: HashMap.HashMap<string, string>,
  currentConvId: string,
): ReadonlyArray<Message> {
  if (convId === currentConvId || messages.length === 0) return [];
  const lastSeenId = Option.getOrUndefined(HashMap.get(viewMarkers, convId));
  const lastSeenIndex =
    lastSeenId !== undefined
      ? messages.findIndex((message) => message.id === lastSeenId)
      : -1;
  return messages.slice(lastSeenIndex + 1);
}

export function makeContextCandidate(
  convId: string,
  newMsgs: ReadonlyArray<Message>,
): ContextCandidate {
  const last = newMsgs[newMsgs.length - 1]!;
  return {
    convId,
    newMsgs,
    lastTs: new Date(last.createdAt).getTime(),
  };
}

function minutesSince(timestamp: string): number {
  return Math.max(
    0,
    Math.round(
      (Date.now() - new Date(timestamp).getTime()) / MILLISECONDS_PER_MINUTE,
    ),
  );
}

function contextEntryForCandidate(
  candidate: ContextCandidate,
  state: CrossConvState,
  maxMessagesPerConv: number,
): {
  readonly entry: CrossConversationEntry;
  readonly advance: readonly [string, string];
} {
  const reportable = candidate.newMsgs.slice(-maxMessagesPerConv);
  const last = reportable[reportable.length - 1]!;
  const senderName = getOr(
    state.agentNamesMap,
    last.senderId,
    () => last.senderId,
  );
  return {
    entry: {
      conversationId: candidate.convId,
      conversationName: Option.getOrUndefined(
        HashMap.get(state.conversationsMap, candidate.convId),
      )?.name,
      senderName,
      text: last.parts.map(renderPart).join(" "),
      minutesAgo: minutesSince(last.createdAt),
      count: reportable.length,
    },
    advance: [candidate.convId, last.id],
  };
}

export function buildContextEntries(
  candidates: ReadonlyArray<ContextCandidate>,
  state: CrossConvState,
  maxMessagesPerConv: number,
): BuiltContextEntries {
  const entries: CrossConversationEntry[] = [];
  const pendingAdvances: Array<readonly [string, string]> = [];
  for (const candidate of candidates) {
    const { entry, advance } = contextEntryForCandidate(
      candidate,
      state,
      maxMessagesPerConv,
    );
    entries.push(entry);
    pendingAdvances.push(advance);
  }
  return { entries, pendingAdvances };
}

const traceConversationId = (
  conversation: Record<string, unknown> | undefined,
  fallback: string | undefined,
): unknown =>
  conversation === undefined ? fallback : (conversation["id"] ?? fallback);

export function notificationTraceRecord(
  notification: DecodedNotification<AnyNotificationDefinition>,
  agentId: string | undefined,
): Record<string, unknown> {
  const params = recordOrEmpty(notification.params);
  const message = recordProperty(params, "message");
  const conversation = recordProperty(params, "conversation");
  const notificationConversationId = stringProperty(params, "conversationId");
  return {
    ts: new Date().toISOString(),
    agentId: agentId ?? "unknown",
    notification: notification.method,
    messageId: message?.["id"],
    messageConversationId: message?.["conversationId"],
    messageSenderId: message?.["senderId"],
    conversationId: traceConversationId(
      conversation,
      notificationConversationId,
    ),
    conversationName: conversation?.["name"],
  };
}
