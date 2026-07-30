import type { NotificationDelivery } from "@moltzap/protocol/rpc";
import type { AnyNotificationDefinition } from "@moltzap/protocol/socket/catalog";
import type { Message } from "@moltzap/protocol/message";
import { HashMap, Option } from "effect";
import type { ConversationMeta, CrossConversationEntry } from "./service.js";
import { renderPart } from "./message-rendering.js";
import { getOr } from "./refs.js";

const MILLISECONDS_PER_MINUTE = 60_000;

/** Describes cross conv state. */
export interface CrossConvState {
  readonly messagesMap: HashMap.HashMap<string, readonly Message[]>;
  readonly conversationsMap: HashMap.HashMap<string, ConversationMeta>;
  readonly agentNamesMap: HashMap.HashMap<string, string>;
  readonly viewMarkers: HashMap.HashMap<string, string>;
}

/** Describes context candidate. */
export interface ContextCandidate {
  readonly convId: string;
  readonly newMsgs: readonly Message[];
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

/**
 * Creates messages for conversation.
 * @param convId Value supplied to the operation.
 * @param messages Value supplied to the operation.
 * @param viewMarkers Value supplied to the operation.
 * @param currentConvId Value supplied to the operation.
 * @returns The new messages for conversation result.
 */
export function newMessagesForConversation(
  convId: string,
  messages: readonly Message[],
  viewMarkers: HashMap.HashMap<string, string>,
  currentConvId: string,
): readonly Message[] {
  if (convId === currentConvId || messages.length === 0) {
    return [];
  }
  const lastSeenId = Option.getOrUndefined(HashMap.get(viewMarkers, convId));
  const lastSeenIndex =
    lastSeenId !== undefined
      ? messages.findIndex((message) => message.id === lastSeenId)
      : -1;
  return messages.slice(lastSeenIndex + 1);
}

/**
 * Creates context candidate.
 * @param convId Value supplied to the operation.
 * @param newMsgs Value supplied to the operation.
 * @returns The created context candidate.
 */
export function makeContextCandidate(
  convId: string,
  newMsgs: readonly Message[],
): ContextCandidate {
  const last =
    /* Safe because the surrounding invariant establishes this asserted shape. */ newMsgs[
      newMsgs.length - 1
    ]!;
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
  const last =
    /* Safe because the surrounding invariant establishes this asserted shape. */ reportable[
      reportable.length - 1
    ]!;
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

/**
 * Creates context entries.
 * @param candidates Value supplied to the operation.
 * @param state Value supplied to the operation.
 * @param maxMessagesPerConv Value supplied to the operation.
 * @returns The created context entries.
 */
export function buildContextEntries(
  candidates: readonly ContextCandidate[],
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
  conversation?: Record<string, unknown>,
  fallback?: string,
): unknown =>
  conversation === undefined ? fallback : (conversation.id ?? fallback);

/**
 * Executes the notification trace record operation.
 * @param notification Value supplied to the operation.
 * @param agentId Identifier of the agent targeted by the operation.
 * @returns The notification trace record result.
 */
export function notificationTraceRecord(
  notification: NotificationDelivery<AnyNotificationDefinition>,
  agentId?: string,
): Record<string, unknown> {
  const params = recordOrEmpty(notification.params);
  const message = recordProperty(params, "message");
  const conversation = recordProperty(params, "conversation");
  const notificationConversationId = stringProperty(params, "conversationId");
  return {
    ts: new Date().toISOString(),
    agentId: agentId ?? "unknown",
    notification: notification.method,
    messageId: message?.id,
    messageConversationId: message?.conversationId,
    messageSenderId: message?.senderId,
    conversationId: traceConversationId(
      conversation,
      notificationConversationId,
    ),
    conversationName: conversation?.name,
  };
}
