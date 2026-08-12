/**
 * @file Pure transformations that derive cross-conversation summaries and
 * cross-conversation summaries from endpoint-local state.
 */

import type { Message } from "@moltzap/protocol/message";
import { HashMap, Option } from "effect";
import type { ConversationMeta, CrossConversationEntry } from "./service.js";
import { renderPart } from "./message-rendering.js";
import { getOr } from "./refs.js";

const MILLISECONDS_PER_MINUTE = 60_000;

/** Immutable state snapshot used to derive another conversation's context. */
export interface CrossConvState {
  readonly messagesMap: HashMap.HashMap<string, readonly Message[]>;
  readonly conversationsMap: HashMap.HashMap<string, ConversationMeta>;
  readonly agentNamesMap: HashMap.HashMap<string, string>;
  readonly viewMarkers: HashMap.HashMap<string, string>;
}

/** Nonempty conversation update ranked by the timestamp of its newest turn. */
export interface ContextCandidate {
  readonly convId: string;
  readonly newMsgs: readonly Message[];
  readonly lastTs: number;
}

interface BuiltContextEntries {
  readonly entries: CrossConversationEntry[];
  readonly pendingAdvances: ReadonlyArray<readonly [string, string]>;
}

/**
 * Selects messages newer than a viewer's marker while excluding the
 * conversation the viewer is already reading.
 * @param convId Conversation that owns the candidate messages.
 * @param messages Stored messages in their presentation order.
 * @param viewMarkers Last-seen message ids keyed by conversation.
 * @param currentConvId Conversation whose prompt is being assembled.
 * @returns The unseen suffix, or an empty list for the current conversation.
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
 * Captures the timestamp used to rank one nonempty unseen-message suffix.
 * @param convId Conversation that owns the unseen messages.
 * @param newMsgs Nonempty unseen suffix established by the caller.
 * @returns A candidate ordered by its newest message timestamp.
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

/**
 * Projects ranked candidates into summaries and the marker updates that a
 * caller may commit after presenting them.
 * @param candidates Ranked, nonempty unseen-message groups.
 * @param state Endpoint-local names and conversation metadata.
 * @param maxMessagesPerConv Maximum messages represented by each summary.
 * @returns Presentation entries paired with their deferred marker advances.
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

function minutesSince(timestamp: string): number {
  return Math.max(
    0,
    Math.round(
      (Date.now() - new Date(timestamp).getTime()) / MILLISECONDS_PER_MINUTE,
    ),
  );
}
