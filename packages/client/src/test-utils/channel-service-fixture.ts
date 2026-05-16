/** Test fixture factory for ChannelService-shaped objects. */

import { Effect } from "effect";
import type { Message } from "@moltzap/protocol";
import { testAgentId, testConversationId } from "./ids.js";
import type {
  ChannelService,
  CrossConversationEntry,
  CrossConvMessage,
  DispatchReleaseFrame,
} from "@moltzap/client";

type MessageHandler = (msg: Message) => void;
type VoidHandler = () => void;
type ConversationArchivedHandler = (data: { conversationId: string }) => void;
type ConversationUnarchivedHandler = (data: { conversationId: string }) => void;
type DispatchReleaseHandler = (frame: DispatchReleaseFrame) => void;
type ServiceEvent =
  | "message"
  | "disconnect"
  | "reconnect"
  | "conversationArchived"
  | "conversationUnarchived"
  | "dispatchRelease";
type ServiceHandler =
  | MessageHandler
  | VoidHandler
  | ConversationArchivedHandler
  | ConversationUnarchivedHandler
  | DispatchReleaseHandler;

interface SentReply {
  convId: string;
  text: string;
  dispatchLeaseId?: string;
}

interface FixtureConversationMeta {
  type: string;
  name?: string;
  participants: string[];
}

interface ChannelServiceFixtureStore {
  readonly messageHandlers: MessageHandler[];
  readonly disconnectHandlers: VoidHandler[];
  readonly reconnectHandlers: VoidHandler[];
  readonly conversationArchivedHandlers: ConversationArchivedHandler[];
  readonly conversationUnarchivedHandlers: ConversationUnarchivedHandler[];
  readonly dispatchReleaseHandlers: DispatchReleaseHandler[];
  readonly conversations: Map<string, FixtureConversationMeta>;
  readonly agentNames: Map<string, string>;
  readonly contextEntriesByConv: Map<string, CrossConversationEntry[]>;
  readonly fullMessagesByConv: Map<string, CrossConvMessage[]>;
  readonly resolveFailures: Map<string, Error>;
  readonly archivedConversationIds: Set<string>;
  readonly resolveCalls: string[];
  readonly sent: SentReply[];
  readonly connectCalls: { count: number };
  readonly closeCalls: { count: number };
  connectResult: unknown;
  ownAgentId: string | undefined;
}

const agentKey = (id: string): string => testAgentId(id);
const conversationKey = (id: string): string => testConversationId(id);

function participantKey(participant: string): string {
  const separatorIndex = participant.indexOf(":");
  if (separatorIndex === -1) return participant;
  const type = participant.slice(0, separatorIndex);
  const id = participant.slice(separatorIndex + ":".length);
  return type === "agent" ? `${type}:${agentKey(id)}` : participant;
}

/** Fire events on the fixture service. */
export interface ChannelServiceEmit {
  message(msg: Message): void;
  disconnect(): void;
  reconnect(): void;
  conversationArchived(data: { conversationId: string }): void;
  conversationUnarchived(data: { conversationId: string }): void;
  dispatchRelease(frame: DispatchReleaseFrame): void;
}

export interface ChannelServiceState {
  setConversation(id: string, meta: FixtureConversationMeta): void;
  setAgentName(id: string, name: string): void;
  setContextEntries(
    currentConvId: string,
    entries: CrossConversationEntry[],
  ): void;
  setFullMessages(currentConvId: string, messages: CrossConvMessage[]): void;
  setResolveAgentNameFailure(agentId: string, err: Error): void;
  setConnectResult(result: unknown): void;
  readonly sent: ReadonlyArray<{
    convId: string;
    text: string;
    dispatchLeaseId?: string;
  }>;
  readonly connectCalls: { count: number };
  readonly closeCalls: { count: number };
  resolveAgentNameCallCount(agentId: string): number;
}

export interface FakeChannelService {
  service: ChannelService;
  emit: ChannelServiceEmit;
  state: ChannelServiceState;
}

export interface CreateFakeChannelServiceOptions {
  ownAgentId?: string;
}

function createFixtureStore(
  opts: CreateFakeChannelServiceOptions = {},
): ChannelServiceFixtureStore {
  const ownAgentId =
    opts.ownAgentId !== undefined ? agentKey(opts.ownAgentId) : undefined;
  return {
    messageHandlers: [],
    disconnectHandlers: [],
    reconnectHandlers: [],
    conversationArchivedHandlers: [],
    conversationUnarchivedHandlers: [],
    dispatchReleaseHandlers: [],
    conversations: new Map(),
    agentNames: new Map(),
    contextEntriesByConv: new Map(),
    fullMessagesByConv: new Map(),
    resolveFailures: new Map(),
    archivedConversationIds: new Set(),
    resolveCalls: [],
    sent: [],
    connectCalls: { count: 0 },
    closeCalls: { count: 0 },
    connectResult: {},
    ownAgentId,
  };
}

function registerServiceHandler(
  store: ChannelServiceFixtureStore,
  event: ServiceEvent,
  handler: ServiceHandler,
): void {
  if (event === "message") {
    store.messageHandlers.push(handler as MessageHandler);
  } else if (event === "disconnect") {
    store.disconnectHandlers.push(handler as VoidHandler);
  } else if (event === "reconnect") {
    store.reconnectHandlers.push(handler as VoidHandler);
  } else if (event === "conversationArchived") {
    store.conversationArchivedHandlers.push(
      handler as ConversationArchivedHandler,
    );
  } else if (event === "conversationUnarchived") {
    store.conversationUnarchivedHandlers.push(
      handler as ConversationUnarchivedHandler,
    );
  } else if (event === "dispatchRelease") {
    store.dispatchReleaseHandlers.push(handler as DispatchReleaseHandler);
  }
}

function connectFixtureService(
  store: ChannelServiceFixtureStore,
): Effect.Effect<unknown> {
  return Effect.sync(() => {
    store.connectCalls.count++;
    return store.connectResult;
  });
}

function sendFixtureReply(
  store: ChannelServiceFixtureStore,
  conversationId: string,
  text: string,
  dispatchLeaseId: string | undefined,
): Effect.Effect<void> {
  return Effect.sync(() => {
    store.sent.push({
      convId: conversationId,
      text,
      ...(dispatchLeaseId ? { dispatchLeaseId } : {}),
    });
  });
}

function getFixtureConversation(
  store: ChannelServiceFixtureStore,
  convId: string,
): FixtureConversationMeta | undefined {
  const meta = store.conversations.get(convId);
  if (!meta) return undefined;
  return { type: meta.type, name: meta.name, participants: meta.participants };
}

function resolveFixtureAgentName(
  store: ChannelServiceFixtureStore,
  agentId: string,
): Effect.Effect<string, never> {
  return Effect.suspend(() => {
    store.resolveCalls.push(agentId);
    const failure = store.resolveFailures.get(agentId);
    if (failure) return Effect.succeed(agentId);
    return Effect.succeed(store.agentNames.get(agentId) ?? agentId);
  });
}

function makeService(store: ChannelServiceFixtureStore): ChannelService {
  return {
    get ownAgentId() {
      return store.ownAgentId;
    },

    on(event: ServiceEvent, handler: ServiceHandler): void {
      registerServiceHandler(store, event, handler);
    },

    connect() {
      return connectFixtureService(store);
    },

    close() {
      store.closeCalls.count++;
    },

    send(
      conversationId: string,
      text: string,
      opts?: { dispatchLeaseId?: string },
    ) {
      const dispatchLeaseId = opts?.dispatchLeaseId;
      return sendFixtureReply(store, conversationId, text, dispatchLeaseId);
    },

    getConversation(convId: string) {
      return getFixtureConversation(store, convId);
    },

    getAgentName(agentId: string) {
      return store.agentNames.get(agentId);
    },

    isConversationArchived(convId: string) {
      return store.archivedConversationIds.has(convId);
    },

    resolveAgentName(agentId: string) {
      return resolveFixtureAgentName(store, agentId);
    },

    peekContextEntries(currentConvId: string) {
      const entries = store.contextEntriesByConv.get(currentConvId) ?? [];
      const commit = (): void => {
        store.contextEntriesByConv.set(currentConvId, []);
      };
      return { entries, commit };
    },

    peekFullMessages(currentConvId: string) {
      const messages = store.fullMessagesByConv.get(currentConvId) ?? [];
      const commit = (): void => {
        store.fullMessagesByConv.set(currentConvId, []);
      };
      return { messages, commit };
    },
  };
}

function makeEmit(store: ChannelServiceFixtureStore): ChannelServiceEmit {
  const emit: ChannelServiceEmit = {
    message(msg) {
      for (const h of store.messageHandlers) h(msg);
    },
    disconnect() {
      for (const h of store.disconnectHandlers) h();
    },
    reconnect() {
      for (const h of store.reconnectHandlers) h();
    },
    conversationArchived(data) {
      const conversationId = conversationKey(data.conversationId);
      store.archivedConversationIds.add(conversationId);
      store.conversations.delete(conversationId);
      for (const h of store.conversationArchivedHandlers) h({ conversationId });
    },
    conversationUnarchived(data) {
      const conversationId = conversationKey(data.conversationId);
      store.archivedConversationIds.delete(conversationId);
      for (const h of store.conversationUnarchivedHandlers)
        h({
          conversationId,
        });
    },
    dispatchRelease(frame) {
      for (const h of store.dispatchReleaseHandlers) h(frame);
    },
  };
  return emit;
}

function makeState(store: ChannelServiceFixtureStore): ChannelServiceState {
  const state: ChannelServiceState = {
    setConversation(id, meta) {
      store.conversations.set(conversationKey(id), {
        ...meta,
        participants: meta.participants.map(participantKey),
      });
    },
    setAgentName(id, name) {
      store.agentNames.set(agentKey(id), name);
    },
    setContextEntries(currentConvId, entries) {
      store.contextEntriesByConv.set(conversationKey(currentConvId), entries);
    },
    setFullMessages(currentConvId, messages) {
      store.fullMessagesByConv.set(conversationKey(currentConvId), messages);
    },
    setResolveAgentNameFailure(agentId, err) {
      store.resolveFailures.set(agentKey(agentId), err);
    },
    setConnectResult(result) {
      store.connectResult = result;
    },
    get sent() {
      return store.sent;
    },
    connectCalls: store.connectCalls,
    closeCalls: store.closeCalls,
    resolveAgentNameCallCount(agentId) {
      return store.resolveCalls.filter((id) => id === agentKey(agentId)).length;
    },
  };
  return state;
}

export function createFakeChannelService(
  opts: CreateFakeChannelServiceOptions = {},
): FakeChannelService {
  const store = createFixtureStore(opts);
  return {
    service: makeService(store),
    emit: makeEmit(store),
    state: makeState(store),
  };
}
