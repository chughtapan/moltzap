/**
 * @file Provides a stateful `ChannelService` fixture whose event, send,
 * context, and lifecycle observations remain explicit to tests.
 */

import type { ConversationId } from "@moltzap/protocol/conversation";
import type { Message } from "@moltzap/protocol/message";
import { Effect } from "effect";
import type { ChannelService } from "../channel-core.js";
import type { CrossConversationEntry, CrossConvMessage } from "../service.js";
import { testAgentId, testConversationId } from "./ids.js";

type MessageHandler = (payload: { message: Message }) => void;
type VoidHandler = () => void;
type ServiceEvent = "message" | "disconnect";
type ServiceHandler = MessageHandler | VoidHandler;

interface SentReply {
  convId: string;
  text: string;
}

interface SendFixtureReplyInput {
  readonly conversationId: ConversationId;
  readonly text: string;
}

interface FixtureConversationMeta {
  type: string;
  name?: string;
  participants: string[];
}

interface ChannelServiceFixtureStore {
  readonly messageHandlers: MessageHandler[];
  readonly disconnectHandlers: VoidHandler[];
  readonly conversations: Map<string, FixtureConversationMeta>;
  readonly agentNames: Map<string, string>;
  readonly contextEntriesByConv: Map<string, CrossConversationEntry[]>;
  readonly fullMessagesByConv: Map<string, CrossConvMessage[]>;
  readonly resolveFailures: Map<string, Error>;
  readonly resolveCalls: string[];
  readonly sent: SentReply[];
  readonly connectCalls: { count: number };
  readonly closeCalls: { count: number };
  connectResult: unknown;
  ownAgentId?: string;
}

/** Event controls for delivering messages and disconnects into the fixture. */
export interface ChannelServiceEmit {
  message(msg: Message): void;
  disconnect(): void;
}

/** Mutable setup controls and observable call state for the fixture. */
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
  readonly sent: readonly SentReply[];
  readonly connectCalls: { count: number };
  readonly closeCalls: { count: number };
  resolveAgentNameCallCount(agentId: string): number;
}

/** Service under test paired with its event and state controls. */
export interface FakeChannelService {
  service: ChannelService;
  emit: ChannelServiceEmit;
  state: ChannelServiceState;
}

/** Initial identity overrides for a channel-service fixture. */
export interface CreateFakeChannelServiceOptions {
  ownAgentId?: string;
}

/**
 * Creates an isolated stateful service fixture with deterministic identifiers.
 * @param opts Optional local-agent identity override.
 * @returns The service and its explicit event and state controls.
 */
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

function createFixtureStore(
  opts: CreateFakeChannelServiceOptions = {},
): ChannelServiceFixtureStore {
  const ownAgentId =
    opts.ownAgentId !== undefined ? agentKey(opts.ownAgentId) : undefined;
  return {
    messageHandlers: [],
    disconnectHandlers: [],
    conversations: new Map(),
    agentNames: new Map(),
    contextEntriesByConv: new Map(),
    fullMessagesByConv: new Map(),
    resolveFailures: new Map(),
    resolveCalls: [],
    sent: [],
    connectCalls: { count: 0 },
    closeCalls: { count: 0 },
    connectResult: {},
    ownAgentId,
  };
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

    send: makeFixtureSend(store),

    getConversation(convId: string) {
      return getFixtureConversation(store, convId);
    },

    getAgentName(agentId: string) {
      return store.agentNames.get(agentId);
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

function registerServiceHandler(
  store: ChannelServiceFixtureStore,
  event: ServiceEvent,
  handler: ServiceHandler,
): void {
  if (event === "message") {
    store.messageHandlers.push(handler);
  } else if (event === "disconnect") {
    store.disconnectHandlers.push(
      /* Safe because the surrounding invariant establishes this asserted shape. */ handler as VoidHandler,
    );
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
  input: SendFixtureReplyInput,
): Effect.Effect<void> {
  return Effect.sync(() => {
    store.sent.push({
      convId: input.conversationId,
      text: input.text,
    });
  });
}

function makeFixtureSend(
  store: ChannelServiceFixtureStore,
): ChannelService["send"] {
  return (conversationId, text) =>
    sendFixtureReply(store, { conversationId, text });
}

function getFixtureConversation(
  store: ChannelServiceFixtureStore,
  convId: string,
): FixtureConversationMeta | undefined {
  const meta = store.conversations.get(convId);
  if (!meta) {
    return undefined;
  }
  return { type: meta.type, name: meta.name, participants: meta.participants };
}

function resolveFixtureAgentName(
  store: ChannelServiceFixtureStore,
  agentId: string,
): Effect.Effect<string> {
  return Effect.suspend(() => {
    store.resolveCalls.push(agentId);
    const failure = store.resolveFailures.get(agentId);
    if (failure) {
      return Effect.succeed(agentId);
    }
    return Effect.succeed(store.agentNames.get(agentId) ?? agentId);
  });
}

function makeEmit(store: ChannelServiceFixtureStore): ChannelServiceEmit {
  const emit: ChannelServiceEmit = {
    message(msg) {
      for (const h of store.messageHandlers) {
        h({ message: msg });
      }
    },
    disconnect() {
      for (const h of store.disconnectHandlers) {
        h();
      }
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

function conversationKey(id: string): string {
  return testConversationId(id);
}

function participantKey(participant: string): string {
  const separatorIndex = participant.indexOf(":");
  if (separatorIndex === -1) {
    return participant;
  }
  const type = participant.slice(0, separatorIndex);
  const id = participant.slice(separatorIndex + ":".length);
  return type === "agent" ? `${type}:${agentKey(id)}` : participant;
}

function agentKey(id: string): string {
  return testAgentId(id);
}
