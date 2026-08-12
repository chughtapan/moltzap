import type { ConversationCreatedNotification } from "@moltzap/protocol/conversation";
import type { Message } from "@moltzap/protocol/message";
import { Effect, HashMap, Option, Ref } from "effect";

const DEFAULT_MAX_CONTEXT_CONVERSATIONS = 5;
const DEFAULT_MAX_MESSAGES_PER_CONVERSATION = 3;
const MILLISECONDS_PER_MINUTE = 60_000;

const snapshot = <A>(ref: Ref.Ref<A>): A => Effect.runSync(Ref.get(ref));

const getOr = <K, V>(
  map: HashMap.HashMap<K, V>,
  key: K,
  fallback: () => V,
): V => Option.getOrElse(HashMap.get(map, key), fallback);

/**
 * Per-conversation message cap. Older messages are evicted FIFO; the
 * on-disk history remains the source of truth. Sized for typical CLI
 * display windows — `conversations get` shows at most a few hundred.
 */
const MAX_MESSAGES_PER_CONV = 1000;

/** Describes conversation meta. */
export interface ConversationMeta {
  id: string;
  type: string;
  name?: string;
  participants: string[];
}

/** Structured summary of recent activity in one other conversation. */
export interface CrossConversationEntry {
  conversationId: string;
  conversationName?: string;
  senderName: string;
  text: string;
  minutesAgo: number;
  /** Messages in this summary (capped by maxMessagesPerConv). */
  count: number;
}

/** Full message from another conversation, used by peekFullMessages(). */
export interface CrossConvMessage {
  conversationId: string;
  conversationName?: string;
  senderName: string;
  senderId: string;
  text: string;
  timestamp: string;
}

/** Immutable snapshots used while selecting cross-conversation context. */
export interface CrossConvState {
  readonly messagesMap: HashMap.HashMap<string, readonly Message[]>;
  readonly conversationsMap: HashMap.HashMap<string, ConversationMeta>;
  readonly agentNamesMap: HashMap.HashMap<string, string>;
  readonly viewMarkers: HashMap.HashMap<string, string>;
}

type MessageTextRenderer = (message: Message) => string;

interface ContextCandidate {
  readonly convId: string;
  readonly newMsgs: readonly Message[];
  readonly lastTs: number;
}

interface BuiltContextEntries {
  readonly entries: CrossConversationEntry[];
  readonly pendingAdvances: ReadonlyArray<readonly [string, string]>;
}

interface AgentName {
  readonly id: string;
  readonly name: string;
}

function newMessagesForConversation(
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

function makeContextCandidate(
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
  renderMessageText: MessageTextRenderer,
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
      text: renderMessageText(last),
      minutesAgo: minutesSince(last.createdAt),
      count: reportable.length,
    },
    advance: [candidate.convId, last.id],
  };
}

function buildContextEntries(
  candidates: readonly ContextCandidate[],
  state: CrossConvState,
  maxMessagesPerConv: number,
  renderMessageText: MessageTextRenderer,
): BuiltContextEntries {
  const entries: CrossConversationEntry[] = [];
  const pendingAdvances: Array<readonly [string, string]> = [];
  for (const candidate of candidates) {
    const { entry, advance } = contextEntryForCandidate(
      candidate,
      state,
      maxMessagesPerConv,
      renderMessageText,
    );
    entries.push(entry);
    pendingAdvances.push(advance);
  }
  return { entries, pendingAdvances };
}

/**
 * Owns the service's in-memory presentation caches and viewer-scoped context
 * markers. Network ingress and presentation rendering remain with the caller.
 */
export class PresentationState {
  private readonly conversationsRef: Ref.Ref<
    HashMap.HashMap<string, ConversationMeta>
  > = Effect.runSync(Ref.make(HashMap.empty<string, ConversationMeta>()));
  private readonly messagesRef: Ref.Ref<
    HashMap.HashMap<string, readonly Message[]>
  > = Effect.runSync(Ref.make(HashMap.empty<string, readonly Message[]>()));
  private readonly agentNamesRef: Ref.Ref<HashMap.HashMap<string, string>> =
    Effect.runSync(Ref.make(HashMap.empty<string, string>()));
  private readonly lastNotifiedRef: Ref.Ref<
    HashMap.HashMap<string, HashMap.HashMap<string, string>>
  > = Effect.runSync(
    Ref.make(HashMap.empty<string, HashMap.HashMap<string, string>>()),
  );

  reset(): Effect.Effect<void> {
    return Effect.all(
      [
        Ref.set(this.conversationsRef, HashMap.empty()),
        Ref.set(this.messagesRef, HashMap.empty()),
        Ref.set(this.agentNamesRef, HashMap.empty()),
        Ref.set(this.lastNotifiedRef, HashMap.empty()),
      ],
      { discard: true },
    );
  }

  getConversation(convId: string): ConversationMeta | undefined {
    return Option.getOrUndefined(
      HashMap.get(snapshot(this.conversationsRef), convId),
    );
  }

  getConversations(): ConversationMeta[] {
    return [...HashMap.values(snapshot(this.conversationsRef))];
  }

  storeConversation(notification: ConversationCreatedNotification): void {
    const { conversationId, name, participants } = notification;
    Effect.runSync(
      Ref.update(this.conversationsRef, (conversations) => {
        // The notification carries the full membership, this agent included,
        // so anything past two members is a group.
        const inferredType: "dm" | "group" =
          participants.length <= 2 ? "dm" : "group";
        return HashMap.set(conversations, conversationId, {
          id: conversationId,
          type: inferredType,
          participants: participants.map(
            (participant) => `agent:${participant}`,
          ),
          ...(name !== undefined ? { name } : {}),
        });
      }),
    );
  }

  getHistory(convId: string, limit: number): Message[] {
    const messages = getOr(
      snapshot(this.messagesRef),
      convId,
      (): readonly Message[] => [],
    );
    return limit ? messages.slice(-limit) : [...messages];
  }

  storeMessage(conversationId: string, message: Message): void {
    Effect.runSync(
      Ref.update(this.messagesRef, (messages) => {
        const existing = getOr(
          messages,
          conversationId,
          (): readonly Message[] => [],
        );
        const appended = [...existing, message];
        const capped =
          appended.length > MAX_MESSAGES_PER_CONV
            ? appended.slice(-MAX_MESSAGES_PER_CONV)
            : appended;
        return HashMap.set(messages, conversationId, capped);
      }),
    );
  }

  getAgentName(agentId: string): string | undefined {
    return Option.getOrUndefined(
      HashMap.get(snapshot(this.agentNamesRef), agentId),
    );
  }

  getAgentNames(): HashMap.HashMap<string, string> {
    return snapshot(this.agentNamesRef);
  }

  cacheAgentNames(agents: readonly AgentName[]): Effect.Effect<void> {
    if (agents.length === 0) {
      return Effect.void;
    }
    return Ref.update(this.agentNamesRef, (names) => {
      let next = names;
      for (const agent of agents) {
        next = HashMap.set(next, agent.id, agent.name);
      }
      return next;
    });
  }

  peekContextEntries(
    currentConvId: string,
    renderMessageText: MessageTextRenderer,
    opts: { maxConversations?: number; maxMessagesPerConv?: number },
  ): { entries: CrossConversationEntry[]; commit: () => void } {
    const maxConversations =
      opts?.maxConversations ?? DEFAULT_MAX_CONTEXT_CONVERSATIONS;
    const maxMessagesPerConversation =
      opts?.maxMessagesPerConv ?? DEFAULT_MAX_MESSAGES_PER_CONVERSATION;
    const state = this.readCrossConvState(currentConvId);
    const candidates = this.collectContextCandidates(state, currentConvId);
    const { entries, pendingAdvances } = buildContextEntries(
      candidates.slice(0, maxConversations),
      state,
      maxMessagesPerConversation,
      renderMessageText,
    );

    return {
      entries,
      commit: () => {
        this.advanceLastNotified(currentConvId, pendingAdvances);
      },
    };
  }

  peekFullMessages(
    currentConvId: string,
    renderMessageText: MessageTextRenderer,
  ): { messages: CrossConvMessage[]; commit: () => void } {
    const { messagesMap, conversationsMap, agentNamesMap, viewMarkers } =
      this.readCrossConvState(currentConvId);

    const allMessages: CrossConvMessage[] = [];
    const pendingAdvances: Array<[string, string]> = [];

    for (const [conversationId, newMessages] of this.iterNewMessagesByConv(
      messagesMap,
      viewMarkers,
      currentConvId,
    )) {
      const conversationName = Option.getOrUndefined(
        HashMap.get(conversationsMap, conversationId),
      )?.name;

      for (const message of newMessages) {
        allMessages.push({
          conversationId,
          conversationName,
          senderName: getOr(
            agentNamesMap,
            message.senderId,
            () => message.senderId,
          ),
          senderId: message.senderId,
          text: renderMessageText(message),
          timestamp: message.createdAt,
        });
      }

      pendingAdvances.push([
        conversationId,
        /* Safe because the surrounding invariant establishes this asserted shape. */ newMessages[
          newMessages.length - 1
        ]!.id,
      ]);
    }

    allMessages.sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp),
    );

    return {
      messages: allMessages,
      commit: () => {
        this.advanceLastNotified(currentConvId, pendingAdvances);
      },
    };
  }

  private readCrossConvState(currentConvId: string): CrossConvState {
    const lastNotifiedMap = snapshot(this.lastNotifiedRef);
    return {
      messagesMap: snapshot(this.messagesRef),
      conversationsMap: snapshot(this.conversationsRef),
      agentNamesMap: snapshot(this.agentNamesRef),
      viewMarkers: getOr(lastNotifiedMap, currentConvId, () =>
        HashMap.empty<string, string>(),
      ),
    };
  }

  private collectContextCandidates(
    state: CrossConvState,
    currentConvId: string,
  ): ContextCandidate[] {
    const candidates: ContextCandidate[] = [];
    for (const [conversationId, newMessages] of this.iterNewMessagesByConv(
      state.messagesMap,
      state.viewMarkers,
      currentConvId,
    )) {
      candidates.push(makeContextCandidate(conversationId, newMessages));
    }
    candidates.sort((left, right) => right.lastTs - left.lastTs);
    return candidates;
  }

  private *iterNewMessagesByConv(
    messagesMap: HashMap.HashMap<string, readonly Message[]>,
    viewMarkers: HashMap.HashMap<string, string>,
    currentConvId: string,
  ): Iterable<[string, readonly Message[]]> {
    for (const [conversationId, messages] of messagesMap) {
      const newMessages = newMessagesForConversation(
        conversationId,
        messages,
        viewMarkers,
        currentConvId,
      );
      if (newMessages.length > 0) {
        yield [conversationId, newMessages];
      }
    }
  }

  private advanceLastNotified(
    currentConvId: string,
    pendingAdvances: ReadonlyArray<readonly [string, string]>,
  ): void {
    if (pendingAdvances.length === 0) {
      return;
    }
    Effect.runSync(
      Ref.update(this.lastNotifiedRef, (outer) => {
        let markers = getOr(outer, currentConvId, () =>
          HashMap.empty<string, string>(),
        );
        for (const [conversationId, messageId] of pendingAdvances) {
          markers = HashMap.set(markers, conversationId, messageId);
        }
        return HashMap.set(outer, currentConvId, markers);
      }),
    );
  }
}
