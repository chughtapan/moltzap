/** Test fixture factory for ChannelService-shaped objects. */

import { Effect } from "effect";
import type { Message } from "@moltzap/protocol";
import { testAgentId, testConversationId } from "./ids.js";
import type {
  ChannelService,
  CrossConversationEntry,
  CrossConvMessage,
  PermissionsRequiredNotification,
} from "../index.js";

type MessageHandler = (msg: Message) => void;
type VoidHandler = () => void;
type PermissionRequiredHandler = (
  data: PermissionsRequiredNotification,
) => void;
type ConversationArchivedHandler = (data: { conversationId: string }) => void;
type ConversationUnarchivedHandler = (data: { conversationId: string }) => void;

interface FixtureConversationMeta {
  type: string;
  name?: string;
  participants: string[];
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
  permissionRequired(data: PermissionsRequiredNotification): void;
  conversationArchived(data: { conversationId: string }): void;
  conversationUnarchived(data: { conversationId: string }): void;
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
  const conversationArchivedHandlers: ConversationArchivedHandler[] = [];
  const conversationUnarchivedHandlers: ConversationUnarchivedHandler[] = [];

  const conversations = new Map<string, FixtureConversationMeta>();
  const agentNames = new Map<string, string>();
  const contextEntriesByConv = new Map<string, CrossConversationEntry[]>();
  const fullMessagesByConv = new Map<string, CrossConvMessage[]>();
  const resolveFailures = new Map<string, Error>();
  const archivedConversationIds = new Set<string>();
  const resolveCalls: string[] = [];
  const sent: Array<{
    convId: string;
    text: string;
    dispatchLeaseId?: string;
  }> = [];
  const connectCalls = { count: 0 };
  const closeCalls = { count: 0 };
  let connectResult: unknown = {};
  let ownAgentId: string | undefined =
    opts.ownAgentId !== undefined ? agentKey(opts.ownAgentId) : undefined;

  const service: ChannelService = {
    get ownAgentId() {
      return ownAgentId;
    },

    on(
      event:
        | "message"
        | "disconnect"
        | "reconnect"
        | "permissionRequired"
        | "conversationArchived"
        | "conversationUnarchived",
      handler:
        | MessageHandler
        | VoidHandler
        | PermissionRequiredHandler
        | ConversationArchivedHandler
        | ConversationUnarchivedHandler,
    ): void {
      if (event === "message") {
        messageHandlers.push(handler as MessageHandler);
      } else if (event === "disconnect") {
        disconnectHandlers.push(handler as VoidHandler);
      } else if (event === "reconnect") {
        reconnectHandlers.push(handler as VoidHandler);
      } else if (event === "permissionRequired") {
        permissionRequiredHandlers.push(handler as PermissionRequiredHandler);
      } else if (event === "conversationArchived") {
        conversationArchivedHandlers.push(
          handler as ConversationArchivedHandler,
        );
      } else if (event === "conversationUnarchived") {
        conversationUnarchivedHandlers.push(
          handler as ConversationUnarchivedHandler,
        );
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

    isConversationArchived(convId: string) {
      return archivedConversationIds.has(convId);
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
    conversationArchived(data) {
      const conversationId = conversationKey(data.conversationId);
      archivedConversationIds.add(conversationId);
      conversations.delete(conversationId);
      for (const h of conversationArchivedHandlers) h({ conversationId });
    },
    conversationUnarchived(data) {
      const conversationId = conversationKey(data.conversationId);
      archivedConversationIds.delete(conversationId);
      for (const h of conversationUnarchivedHandlers) h({ conversationId });
    },
  };

  const state: ChannelServiceState = {
    setConversation(id, meta) {
      conversations.set(conversationKey(id), {
        ...meta,
        participants: meta.participants.map(participantKey),
      });
    },
    setAgentName(id, name) {
      agentNames.set(agentKey(id), name);
    },
    setContextEntries(currentConvId, entries) {
      contextEntriesByConv.set(conversationKey(currentConvId), entries);
    },
    setFullMessages(currentConvId, messages) {
      fullMessagesByConv.set(conversationKey(currentConvId), messages);
    },
    setResolveAgentNameFailure(agentId, err) {
      resolveFailures.set(agentKey(agentId), err);
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
      return resolveCalls.filter((id) => id === agentKey(agentId)).length;
    },
  };

  return { service, emit, state };
}
