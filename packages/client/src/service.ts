import { type EventFrame, type Message, EventNames } from "@moltzap/protocol";
import { MoltZapWsClient, type WsClientLogger } from "./ws-client.js";

export interface ConversationMeta {
  id: string;
  type: string;
  name?: string;
  participants: string[];
}

export interface ContextOptions {
  type: "cross-conversation";
  maxConversations?: number;
  maxMessagesPerConv?: number;
}

export interface ServiceOptions {
  serverUrl: string;
  agentKey: string;
  logger?: WsClientLogger;
}

type EventHandler<T> = (data: T) => void;

interface HelloOk {
  agentId: string;
  conversations?: Array<{
    id: string;
    type: string;
    name?: string;
    participants?: Array<{ type: string; id: string }>;
  }>;
  unreadCounts?: Record<string, number>;
}

const MAX_MESSAGES_PER_CONV = 20;

/**
 * Stateful MoltZap client that manages connection, conversation tracking,
 * agent name resolution, and cross-conversation context generation.
 */
export class MoltZapService {
  private client: MoltZapWsClient | null = null;
  private _connected = false;

  private conversations = new Map<string, ConversationMeta>();
  private messages = new Map<string, Message[]>();
  private agentNames = new Map<string, string>();
  private lastNotified = new Map<string, Map<string, number>>();

  private messageHandlers: EventHandler<Message>[] = [];
  private rawEventHandlers: EventHandler<EventFrame>[] = [];
  private disconnectHandlers: EventHandler<void>[] = [];
  private reconnectHandlers: EventHandler<HelloOk>[] = [];
  private pendingNameLookups = new Map<string, Promise<string>>();

  ownAgentId: string | undefined;

  constructor(private opts: ServiceOptions) {}

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<HelloOk> {
    this.client = new MoltZapWsClient({
      serverUrl: this.opts.serverUrl,
      agentKey: this.opts.agentKey,
      logger: this.opts.logger,
      onEvent: (event) => this.handleEvent(event),
      onDisconnect: () => {
        this._connected = false;
        for (const h of this.disconnectHandlers) h();
      },
      onReconnect: (helloOk) => {
        this._connected = true;
        const hello = helloOk as HelloOk;
        this.populateFromHello(hello);
        for (const h of this.reconnectHandlers) h(hello);
      },
    });

    const helloOk = (await this.client.connect()) as HelloOk;
    this._connected = true;
    this.ownAgentId = helloOk.agentId;
    this.populateFromHello(helloOk);
    return helloOk;
  }

  close(): void {
    this._connected = false;
    this.client?.close();
    this.client = null;
    this.conversations.clear();
    this.messages.clear();
    this.agentNames.clear();
    this.lastNotified.clear();
  }

  // --- Conversations ---

  getConversation(convId: string): ConversationMeta | undefined {
    return this.conversations.get(convId);
  }

  getConversations(): ConversationMeta[] {
    return [...this.conversations.values()];
  }

  // --- Messages ---

  getHistory(convId: string, limit = 20): Message[] {
    const msgs = this.messages.get(convId) ?? [];
    return msgs.slice(-limit);
  }

  // --- Agent Names ---

  getAgentName(agentId: string): string | undefined {
    return this.agentNames.get(agentId);
  }

  async resolveAgentName(agentId: string): Promise<string> {
    const cached = this.agentNames.get(agentId);
    if (cached) return cached;

    const pending = this.pendingNameLookups.get(agentId);
    if (pending) return pending;

    const promise = (async () => {
      const result = (await this.sendRpc("agents/lookup", {
        agentIds: [agentId],
      })) as { agents: Array<{ id: string; name: string }> };

      const agent = result.agents[0];
      if (agent) {
        this.agentNames.set(agentId, agent.name);
        return agent.name;
      }
      return agentId;
    })();

    this.pendingNameLookups.set(agentId, promise);
    try {
      return await promise;
    } finally {
      this.pendingNameLookups.delete(agentId);
    }
  }

  // --- Messaging ---

  async send(
    convId: string,
    text: string,
    opts?: { replyTo?: string },
  ): Promise<void> {
    await this.sendRpc("messages/send", {
      conversationId: convId,
      parts: [{ type: "text", text }],
      ...(opts?.replyTo ? { replyToId: opts.replyTo } : {}),
    });
  }

  // --- Cross-Conversation Context ---

  /**
   * Generate a system reminder with updates from other conversations.
   * Each conversation has its own view of what's "new" — markers are tracked
   * per viewing conversation and advanced after notification.
   */
  getContext(
    currentConvId: string,
    opts?: ContextOptions,
  ): string | null {
    const maxConvs = opts?.maxConversations ?? 5;
    const maxMsgsPerConv = opts?.maxMessagesPerConv ?? 3;
    const viewMarkers =
      this.lastNotified.get(currentConvId) ?? new Map<string, number>();

    const updates: string[] = [];

    for (const [convId, msgs] of this.messages) {
      if (convId === currentConvId || msgs.length === 0) continue;
      if (updates.length >= maxConvs) break;

      const lastSeenSeq = viewMarkers.get(convId) ?? 0;
      const newMsgs = msgs.filter((m) => m.seq > lastSeenSeq);
      if (newMsgs.length === 0) continue;

      const reportable = newMsgs.slice(-maxMsgsPerConv);
      const last = reportable[reportable.length - 1]!;
      const senderName = this.resolveSenderLabel(last.sender.id);
      const ago = Math.max(
        0,
        Math.round(
          (Date.now() - new Date(last.createdAt).getTime()) / 60_000,
        ),
      );
      const text = last.parts
        .filter((p) => p.type === "text" && "text" in p)
        .map((p) => (p as { text: string }).text)
        .join(" ");

      updates.push(
        `@${senderName} (${ago}m ago): (${reportable.length} new) "${text.slice(0, 120)}"`,
      );

      viewMarkers.set(convId, last.seq);
    }

    this.lastNotified.set(currentConvId, viewMarkers);

    if (updates.length === 0) return null;

    return [
      "<system-reminder>",
      `Recent updates (you are in conv:${currentConvId}):`,
      ...updates,
      "</system-reminder>",
    ].join("\n");
  }

  // --- Events ---

  on(event: "message", handler: EventHandler<Message>): void;
  on(event: "rawEvent", handler: EventHandler<EventFrame>): void;
  on(event: "disconnect", handler: EventHandler<void>): void;
  on(event: "reconnect", handler: EventHandler<HelloOk>): void;
  on(
    event: "message" | "rawEvent" | "disconnect" | "reconnect",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: EventHandler<any>,
  ): void {
    switch (event) {
      case "message":
        this.messageHandlers.push(handler as EventHandler<Message>);
        break;
      case "rawEvent":
        this.rawEventHandlers.push(handler as EventHandler<EventFrame>);
        break;
      case "disconnect":
        this.disconnectHandlers.push(handler as EventHandler<void>);
        break;
      case "reconnect":
        this.reconnectHandlers.push(handler as EventHandler<HelloOk>);
        break;
    }
  }

  // --- RPC passthrough ---

  async sendRpc(method: string, params?: unknown): Promise<unknown> {
    if (!this.client) throw new Error("Not connected");
    return this.client.sendRpc(method, params);
  }

  // --- Internals ---

  private populateFromHello(hello: HelloOk): void {
    if (!hello.conversations) return;
    for (const conv of hello.conversations) {
      this.conversations.set(conv.id, {
        id: conv.id,
        type: conv.type,
        name: conv.name,
        participants: (conv.participants ?? []).map(
          (p) => `${p.type}:${p.id}`,
        ),
      });
    }
  }

  private handleEvent(event: EventFrame): void {
    for (const h of this.rawEventHandlers) h(event);

    switch (event.event) {
      case EventNames.MessageReceived: {
        const msg = (event.data as { message: Message }).message;
        this.storeMessage(msg);
        // Resolve sender name in background
        if (msg.sender.type === "agent" && !this.agentNames.has(msg.sender.id)) {
          void this.resolveAgentName(msg.sender.id);
        }
        // Emit to external handlers (only non-own messages)
        if (msg.sender.id !== this.ownAgentId) {
          for (const h of this.messageHandlers) h(msg);
        }
        break;
      }
      case EventNames.ConversationCreated:
      case EventNames.ConversationUpdated: {
        const data = event.data as {
          conversation: { id: string; type: string; name?: string };
        };
        const existing = this.conversations.get(data.conversation.id);
        this.conversations.set(data.conversation.id, {
          id: data.conversation.id,
          type: data.conversation.type,
          name: data.conversation.name,
          participants: existing?.participants ?? [],
        });
        break;
      }
    }
  }

  private storeMessage(msg: Message): void {
    const buf = this.messages.get(msg.conversationId) ?? [];
    buf.push(msg);
    if (buf.length > MAX_MESSAGES_PER_CONV) buf.shift();
    this.messages.set(msg.conversationId, buf);
  }

  private resolveSenderLabel(senderId: string): string {
    return this.agentNames.get(senderId) ?? senderId;
  }
}
