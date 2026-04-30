/** Test fixture factory for ChannelService-shaped objects. */

import { Effect } from "effect";
import type { Message } from "@moltzap/protocol";
import type {
  ChannelService,
  CrossConversationEntry,
  CrossConvMessage,
  PermissionsRequiredEvent,
} from "../index.js";

type MessageHandler = (msg: Message) => void;
type VoidHandler = () => void;
type PermissionRequiredHandler = (data: PermissionsRequiredEvent) => void;

interface FixtureConversationMeta {
  type: string;
  name?: string;
  participants: string[];
}

/** Fire events on the fixture service. */
export interface ChannelServiceEmit {
  message(msg: Message): void;
  disconnect(): void;
  reconnect(): void;
  permissionRequired(data: PermissionsRequiredEvent): void;
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

export function createFakeChannelService(
  opts: CreateFakeChannelServiceOptions = {},
): FakeChannelService {
  const messageHandlers: MessageHandler[] = [];
  const disconnectHandlers: VoidHandler[] = [];
  const reconnectHandlers: VoidHandler[] = [];
  const permissionRequiredHandlers: PermissionRequiredHandler[] = [];

  const conversations = new Map<string, FixtureConversationMeta>();
  const agentNames = new Map<string, string>();
  const contextEntriesByConv = new Map<string, CrossConversationEntry[]>();
  const fullMessagesByConv = new Map<string, CrossConvMessage[]>();
  const resolveFailures = new Map<string, Error>();
  const resolveCalls: string[] = [];
  const sent: Array<{
    convId: string;
    text: string;
    dispatchLeaseId?: string;
  }> = [];
  const connectCalls = { count: 0 };
  const closeCalls = { count: 0 };
  let connectResult: unknown = {};
  let ownAgentId: string | undefined = opts.ownAgentId;

  const service: ChannelService = {
    get ownAgentId() {
      return ownAgentId;
    },

    on(
      event: "message" | "disconnect" | "reconnect" | "permissionRequired",
      handler: MessageHandler | VoidHandler | PermissionRequiredHandler,
    ): void {
      if (event === "message") {
        messageHandlers.push(handler as MessageHandler);
      } else if (event === "disconnect") {
        disconnectHandlers.push(handler as VoidHandler);
      } else if (event === "reconnect") {
        reconnectHandlers.push(handler as VoidHandler);
      } else if (event === "permissionRequired") {
        permissionRequiredHandlers.push(handler as PermissionRequiredHandler);
      }
    },

    connect() {
      return Effect.sync(() => {
        connectCalls.count++;
        return connectResult;
      });
    },

    close() {
      closeCalls.count++;
    },

    send(
      conversationId: string,
      text: string,
      opts?: { dispatchLeaseId?: string },
    ) {
      return Effect.sync(() => {
        sent.push({
          convId: conversationId,
          text,
          ...(opts?.dispatchLeaseId
            ? { dispatchLeaseId: opts.dispatchLeaseId }
            : {}),
        });
      });
    },

    getConversation(convId: string) {
      const m = conversations.get(convId);
      if (!m) return undefined;
      return { type: m.type, name: m.name, participants: m.participants };
    },

    getAgentName(agentId: string) {
      return agentNames.get(agentId);
    },

    resolveAgentName(agentId: string) {
      return Effect.suspend(() => {
        resolveCalls.push(agentId);
        const failure = resolveFailures.get(agentId);
        // Match real MoltZapService.resolveAgentName semantics: never fail,
        // fall back to the raw agentId so downstream callers (e.g.
        // MoltZapChannelCore.enrichMessage) render something instead of
        // crashing. Tests that inject a failure use this to assert the
        // fallback path.
        if (failure) return Effect.succeed(agentId);
        return Effect.succeed(agentNames.get(agentId) ?? agentId);
      });
    },

    peekContextEntries(currentConvId: string) {
      const entries = contextEntriesByConv.get(currentConvId) ?? [];
      const commit = (): void => {
        contextEntriesByConv.set(currentConvId, []);
      };
      return { entries, commit };
    },

    peekFullMessages(currentConvId: string) {
      const messages = fullMessagesByConv.get(currentConvId) ?? [];
      const commit = (): void => {
        fullMessagesByConv.set(currentConvId, []);
      };
      return { messages, commit };
    },
  };

  const emit: ChannelServiceEmit = {
    message(msg) {
      for (const h of messageHandlers) h(msg);
    },
    disconnect() {
      for (const h of disconnectHandlers) h();
    },
    reconnect() {
      for (const h of reconnectHandlers) h();
    },
    permissionRequired(data) {
      for (const h of permissionRequiredHandlers) h(data);
    },
  };

  const state: ChannelServiceState = {
    setConversation(id, meta) {
      conversations.set(id, meta);
    },
    setAgentName(id, name) {
      agentNames.set(id, name);
    },
    setContextEntries(currentConvId, entries) {
      contextEntriesByConv.set(currentConvId, entries);
    },
    setFullMessages(currentConvId, messages) {
      fullMessagesByConv.set(currentConvId, messages);
    },
    setResolveAgentNameFailure(agentId, err) {
      resolveFailures.set(agentId, err);
    },
    setConnectResult(result) {
      connectResult = result;
    },
    get sent() {
      return sent;
    },
    connectCalls,
    closeCalls,
    resolveAgentNameCallCount(agentId) {
      return resolveCalls.filter((id) => id === agentId).length;
    },
  };

  return { service, emit, state };
}
