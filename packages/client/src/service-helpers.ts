import type { NotificationDelivery } from "@moltzap/protocol/transport";
import type { AnyNotificationDefinition } from "@moltzap/protocol/rpc-method-groups";
import type { Message } from "@moltzap/protocol/task";
import { HashMap, Option } from "effect";
import type { ConversationMeta, CrossConversationEntry } from "./service.js";
import { renderPart } from "./message-rendering.js";
import { getOr } from "./refs.js";

const MILLISECONDS_PER_MINUTE = 60_000;

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
  notification: NotificationDelivery<AnyNotificationDefinition>,
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
