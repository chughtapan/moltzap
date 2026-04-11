import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  type EventFrame,
  type Message,
  type Part,
  EventNames,
} from "@moltzap/protocol";
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

function renderPart(p: Part): string {
  switch (p.type) {
    case "text":
      return p.text;
    case "image":
      return "[image]";
    case "file":
      return `[file: ${p.name}]`;
    default:
      return `[${(p as { type: string }).type}]`;
  }
}

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
  private agentConversationCache = new Map<string, string>();
  private lastNotified = new Map<string, Map<string, number>>();
  private lastRead = new Map<string, Map<string, number>>();

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
    this.stopSocketServer();
    this.client?.close();
    this.client = null;
    this.conversations.clear();
    this.messages.clear();
    this.agentNames.clear();
    this.agentConversationCache.clear();
    this.lastNotified.clear();
    this.lastRead.clear();
  }

  // --- Socket Server ---

  private socketServer: net.Server | null = null;
  private activeSocketPath: string | null = null;

  /** Default socket path for CLI discovery. Per-instance path uses agentId. */
  static readonly SOCKET_PATH = path.join(
    os.homedir(),
    ".moltzap",
    "service.sock",
  );

  /** Per-instance socket path based on connected agentId. */
  get socketPath(): string {
    const id = this.ownAgentId ?? "default";
    return path.join(os.homedir(), ".moltzap", `service-${id}.sock`);
  }

  startSocketServer(): void {
    const sockPath = this.socketPath;
    this.activeSocketPath = sockPath;
    try {
      fs.unlinkSync(sockPath);
    } catch {}
    fs.mkdirSync(path.dirname(sockPath), { recursive: true });

    this.socketServer = net.createServer((conn) => {
      let buffer = "";
      conn.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop()!;
        for (const line of lines) {
          if (!line.trim()) continue;
          void this.handleSocketLine(line, conn);
        }
      });
    });
    this.socketServer.listen(sockPath);

    // Symlink default path to this instance for CLI discovery
    try {
      fs.unlinkSync(MoltZapService.SOCKET_PATH);
    } catch {}
    try {
      fs.symlinkSync(sockPath, MoltZapService.SOCKET_PATH);
    } catch {}
  }

  stopSocketServer(): void {
    this.socketServer?.close();
    this.socketServer = null;
    const sockPath = this.activeSocketPath ?? this.socketPath;
    this.activeSocketPath = null;
    try {
      fs.unlinkSync(sockPath);
    } catch {}
    // Remove default symlink if it points to this instance
    try {
      const target = fs.readlinkSync(MoltZapService.SOCKET_PATH);
      if (target === sockPath) fs.unlinkSync(MoltZapService.SOCKET_PATH);
    } catch {}
  }

  private async handleSocketLine(
    line: string,
    conn: net.Socket,
  ): Promise<void> {
    try {
      const req = JSON.parse(line) as Record<string, unknown>;
      if (typeof req.method !== "string" || !req.method) {
        throw new Error("method is required and must be a string");
      }
      const params =
        req.params != null && typeof req.params === "object"
          ? (req.params as Record<string, unknown>)
          : {};
      const result = await this.handleSocketRequest(req.method, params);
      conn.write(JSON.stringify({ result }) + "\n");
    } catch (err) {
      conn.write(
        JSON.stringify({
          error: err instanceof Error ? err.message : String(err),
        }) + "\n",
      );
    }
  }

  private async handleSocketRequest(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case "ping":
        return { ok: true, agentId: this.ownAgentId };

      case "status":
        return {
          agentId: this.ownAgentId,
          connected: this._connected,
          conversations: this.getConversations().length,
        };

      case "history": {
        if (
          typeof params.conversationId !== "string" ||
          !params.conversationId
        ) {
          throw new Error("conversationId is required and must be a string");
        }
        if (params.limit !== undefined && typeof params.limit !== "number") {
          throw new Error("limit must be a number");
        }
        const convId = params.conversationId;
        const limit = (params.limit as number) ?? 10;
        const sessionKey = params.sessionKey as string | undefined;
        const afterSeq = params.afterSeq as number | undefined;
        const beforeSeq = params.beforeSeq as number | undefined;

        const result = (await this.sendRpc("messages/list", {
          conversationId: convId,
          limit,
          ...(afterSeq !== undefined ? { afterSeq } : {}),
          ...(beforeSeq !== undefined ? { beforeSeq } : {}),
        })) as { messages: Message[]; hasMore: boolean };

        // Resolve agent names (batch) + fetch conversation metadata (concurrent)
        const unknownAgentIds = [
          ...new Set(
            result.messages
              .filter((m) => m.sender.type === "agent")
              .map((m) => m.sender.id),
          ),
        ].filter((id) => !this.agentNames.has(id));

        const [, convMeta] = await Promise.all([
          unknownAgentIds.length > 0
            ? this.sendRpc("agents/lookup", { agentIds: unknownAgentIds }).then(
                (res) => {
                  for (const a of (
                    res as { agents: Array<{ id: string; name: string }> }
                  ).agents) {
                    this.agentNames.set(a.id, a.name);
                  }
                },
              )
            : Promise.resolve(),
          this.sendRpc("conversations/get", { conversationId: convId })
            .then(
              (res) =>
                (res as { conversation: { type: string; name?: string } })
                  .conversation,
            )
            .catch(
              () => undefined as { type: string; name?: string } | undefined,
            ),
        ]);

        // Determine what's "new" using lastRead (not lastNotified).
        // lastNotified is advanced by getContext() (system-reminder).
        // lastRead is advanced here when the agent explicitly reads history.
        // This means messages stay "new" until the agent reads them via history,
        // even if the system-reminder already notified about them.
        const readMarkers = sessionKey
          ? (this.lastRead.get(sessionKey) ?? new Map<string, number>())
          : null;
        const lastReadSeq = readMarkers?.get(convId) ?? 0;

        const messages = result.messages.map((m) => {
          const text = m.parts.map(renderPart).join(" ");
          return {
            seq: m.seq,
            senderId: m.sender.id,
            senderName:
              m.sender.id === this.ownAgentId
                ? "you"
                : (this.agentNames.get(m.sender.id) ?? m.sender.id),
            isOwn: m.sender.id === this.ownAgentId,
            text,
            createdAt: m.createdAt,
            isNew: sessionKey ? m.seq > lastReadSeq : false,
          };
        });

        // Advance lastRead to the highest seq in the returned page.
        // The agent has seen these messages; older ones (if paginated) remain
        // accessible via afterSeq/beforeSeq cursors.
        if (sessionKey && result.messages.length > 0) {
          const maxSeq = Math.max(...result.messages.map((m) => m.seq));
          if (!this.lastRead.has(sessionKey)) {
            this.lastRead.set(sessionKey, new Map());
          }
          const current = this.lastRead.get(sessionKey)!.get(convId) ?? 0;
          if (maxSeq > current) {
            this.lastRead.get(sessionKey)!.set(convId, maxSeq);
          }
        }

        return {
          messages,
          hasMore: result.hasMore,
          conversationMeta: convMeta,
          newCount: messages.filter((m) => m.isNew).length,
        };
      }

      default:
        // Passthrough: forward any other method to the MoltZap server via RPC
        return this.sendRpc(method, params);
    }
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

  async sendToAgent(
    agentName: string,
    text: string,
    opts?: { replyTo?: string },
  ): Promise<void> {
    let conversationId = this.agentConversationCache.get(agentName);
    if (!conversationId) {
      const lookupResult = (await this.sendRpc("agents/lookupByName", {
        name: agentName,
      })) as { agent: { id: string } };
      const createResult = (await this.sendRpc("conversations/create", {
        type: "dm",
        participants: [{ type: "agent", id: lookupResult.agent.id }],
      })) as { conversation: { id: string } };
      conversationId = createResult.conversation.id;
      this.agentConversationCache.set(agentName, conversationId);
    }
    await this.send(conversationId, text, opts);
  }

  // --- Cross-Conversation Context ---

  /**
   * Generate a system reminder with updates from other conversations.
   * Each conversation has its own view of what's "new" — markers are tracked
   * per viewing conversation and advanced after notification.
   */
  getContext(currentConvId: string, opts?: ContextOptions): string | null {
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
        Math.round((Date.now() - new Date(last.createdAt).getTime()) / 60_000),
      );
      const text = last.parts.map(renderPart).join(" ");

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

  /**
   * Fetch full conversation details (including participants) via RPC and merge
   * into the local cache. Called on ConversationCreated events because the
   * event schema omits the participants list — see protocol/events.ts.
   */
  private async refreshConversationParticipants(
    conversationId: string,
  ): Promise<void> {
    try {
      const res = (await this.sendRpc("conversations/get", {
        conversationId,
      })) as {
        conversation: { id: string; type: string; name?: string };
        participants: Array<{ participant: { type: string; id: string } }>;
      };
      const existing = this.conversations.get(conversationId);
      this.conversations.set(conversationId, {
        id: res.conversation.id,
        type: res.conversation.type,
        name: res.conversation.name,
        participants: res.participants.map(
          (p) => `${p.participant.type}:${p.participant.id}`,
        ),
        // Preserve any fields the existing entry had that we don't overwrite.
        ...(existing ? {} : {}),
      });
    } catch {
      // Best-effort refresh. Leave the existing entry in place on failure.
    }
  }

  private populateFromHello(hello: HelloOk): void {
    if (!hello.conversations) return;
    for (const conv of hello.conversations) {
      this.conversations.set(conv.id, {
        id: conv.id,
        type: conv.type,
        name: conv.name,
        participants: (conv.participants ?? []).map((p) => `${p.type}:${p.id}`),
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
        if (
          msg.sender.type === "agent" &&
          !this.agentNames.has(msg.sender.id)
        ) {
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
        // The ConversationCreated event schema doesn't carry participants
        // (protocol/schema/events.ts: ConversationSchema is id/type/name/
        // createdBy/timestamps only). Fetch full details asynchronously so
        // downstream code that reads getConversation(id).participants sees
        // a populated list within a round-trip of the event.
        if (event.event === EventNames.ConversationCreated) {
          void this.refreshConversationParticipants(data.conversation.id);
        }
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
