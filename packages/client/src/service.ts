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

/** Escape `<`, `>`, `&` so sender content can't escape a `<system-reminder>` block. */
export function sanitizeForSystemReminder(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Format CrossConversationEntry[] as a `<system-reminder>` block. Adapters
 * that inline context into prompt text (nanoclaw) and `MoltZapService.getContext`
 * share this formatter so sanitization and line shape stay in one place.
 */
export function formatCrossConversationBlock(
  entries: CrossConversationEntry[],
  opts: { header: string },
): string | null {
  if (entries.length === 0) return null;
  const lines = entries.map((e) => {
    const safeSender = sanitizeForSystemReminder(e.senderName);
    const safeText = sanitizeForSystemReminder(e.text.slice(0, 120));
    return `@${safeSender} (${e.minutesAgo}m ago): (${e.count} new) "${safeText}"`;
  });
  return [
    "<system-reminder>",
    opts.header,
    ...lines,
    "</system-reminder>",
  ].join("\n");
}

export interface ServiceOptions {
  serverUrl: string;
  agentKey: string;
  logger?: WsClientLogger;
}

export interface PermissionRequiredData {
  sessionId: string;
  appId: string;
  resource: string;
  access: string[];
  requestId: string;
  targetUserId: string;
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

/** Full message from another conversation, used by peekFullMessages(). */
export interface CrossConvMessage {
  conversationId: string;
  conversationName?: string;
  senderName: string;
  senderId: string;
  text: string;
  timestamp: string;
}

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
  private lastNotified = new Map<string, Map<string, string>>();
  private lastRead = new Map<string, Map<string, Set<string>>>();

  private messageHandlers: EventHandler<Message>[] = [];
  private rawEventHandlers: EventHandler<EventFrame>[] = [];
  private disconnectHandlers: EventHandler<void>[] = [];
  private reconnectHandlers: EventHandler<HelloOk>[] = [];
  private permissionRequiredHandlers: EventHandler<PermissionRequiredData>[] =
    [];
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
    this.permissionRequiredHandlers.length = 0;
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
        const result = (await this.sendRpc("messages/list", {
          conversationId: convId,
          limit,
        })) as { messages: Message[]; hasMore: boolean };

        // Resolve agent names (batch) + fetch conversation metadata (concurrent)
        const unknownAgentIds = [
          ...new Set(result.messages.map((m) => m.senderId)),
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
        const lastReadIds = sessionKey
          ? (this.lastRead.get(sessionKey)?.get(convId) ?? new Set<string>())
          : new Set<string>();

        const messages = result.messages.map((m) => {
          const text = m.parts.map(renderPart).join(" ");
          return {
            id: m.id,
            senderId: m.senderId,
            senderName:
              m.senderId === this.ownAgentId
                ? "you"
                : (this.agentNames.get(m.senderId) ?? m.senderId),
            isOwn: m.senderId === this.ownAgentId,
            text,
            createdAt: m.createdAt,
            isNew: sessionKey ? !lastReadIds.has(m.id) : false,
          };
        });

        // Advance lastRead to include all message IDs in the returned page.
        if (sessionKey && result.messages.length > 0) {
          if (!this.lastRead.has(sessionKey)) {
            this.lastRead.set(sessionKey, new Map());
          }
          const readSet =
            this.lastRead.get(sessionKey)!.get(convId) ?? new Set<string>();
          for (const m of result.messages) {
            readSet.add(m.id);
          }
          this.lastRead.get(sessionKey)!.set(convId, readSet);
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

  getHistory(convId: string, limit?: number): Message[] {
    const msgs = this.messages.get(convId) ?? [];
    return limit ? msgs.slice(-limit) : [...msgs];
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
    const { entries, commit } = this.peekContextEntries(currentConvId, opts);
    if (entries.length === 0) return null;
    commit();
    return formatCrossConversationBlock(entries, {
      header: `Recent updates (you are in conv:${currentConvId}):`,
    });
  }

  /**
   * Return recent activity in other conversations without advancing any state.
   * Call `commit()` on the result to mark the returned messages as seen so
   * subsequent peeks return only what's new. A caller that reads without
   * committing can re-peek idempotently.
   */
  peekContextEntries(
    currentConvId: string,
    opts?: { maxConversations?: number; maxMessagesPerConv?: number },
  ): { entries: CrossConversationEntry[]; commit: () => void } {
    const maxConvs = opts?.maxConversations ?? 5;
    const maxMsgsPerConv = opts?.maxMessagesPerConv ?? 3;
    const viewMarkers =
      this.lastNotified.get(currentConvId) ?? new Map<string, string>();

    const entries: CrossConversationEntry[] = [];
    const pendingAdvances: Array<[string, string]> = [];

    for (const [convId, msgs] of this.messages) {
      if (convId === currentConvId || msgs.length === 0) continue;
      if (entries.length >= maxConvs) break;

      const lastSeenId = viewMarkers.get(convId);
      const lastSeenIdx = lastSeenId
        ? msgs.findIndex((m) => m.id === lastSeenId)
        : -1;
      const newMsgs = msgs.slice(lastSeenIdx + 1);
      if (newMsgs.length === 0) continue;

      const reportable = newMsgs.slice(-maxMsgsPerConv);
      const last = reportable[reportable.length - 1]!;
      const senderName = this.resolveSenderLabel(last.senderId);
      const minutesAgo = Math.max(
        0,
        Math.round((Date.now() - new Date(last.createdAt).getTime()) / 60_000),
      );
      const text = last.parts.map(renderPart).join(" ");

      entries.push({
        conversationId: convId,
        conversationName: this.conversations.get(convId)?.name,
        senderName,
        text,
        minutesAgo,
        count: reportable.length,
      });

      pendingAdvances.push([convId, last.id]);
    }

    const commit = (): void => {
      for (const [convId, msgId] of pendingAdvances) {
        viewMarkers.set(convId, msgId);
      }
      this.lastNotified.set(currentConvId, viewMarkers);
    };

    return { entries, commit };
  }

  /**
   * Return all new messages from all other conversations as full transcripts,
   * sorted chronologically. Uses the same lastNotified markers as
   * peekContextEntries. Call commit() to advance markers.
   */
  peekFullMessages(currentConvId: string): {
    messages: CrossConvMessage[];
    commit: () => void;
  } {
    const viewMarkers =
      this.lastNotified.get(currentConvId) ?? new Map<string, string>();

    const allMessages: CrossConvMessage[] = [];
    const pendingAdvances: Array<[string, string]> = [];

    for (const [convId, msgs] of this.messages) {
      if (convId === currentConvId || msgs.length === 0) continue;

      const lastSeenId = viewMarkers.get(convId);
      const lastSeenIdx = lastSeenId
        ? msgs.findIndex((m) => m.id === lastSeenId)
        : -1;
      const newMsgs = msgs.slice(lastSeenIdx + 1);
      if (newMsgs.length === 0) continue;

      const convName = this.conversations.get(convId)?.name;

      for (const m of newMsgs) {
        const text = m.parts.map(renderPart).join(" ");
        allMessages.push({
          conversationId: convId,
          conversationName: convName,
          senderName: this.resolveSenderLabel(m.senderId),
          senderId: m.senderId,
          text,
          timestamp: m.createdAt,
        });
      }

      pendingAdvances.push([convId, newMsgs[newMsgs.length - 1]!.id]);
    }

    allMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const commit = (): void => {
      for (const [convId, msgId] of pendingAdvances) {
        viewMarkers.set(convId, msgId);
      }
      this.lastNotified.set(currentConvId, viewMarkers);
    };

    return { messages: allMessages, commit };
  }

  // --- Events ---

  on(event: "message", handler: EventHandler<Message>): void;
  on(event: "rawEvent", handler: EventHandler<EventFrame>): void;
  on(event: "disconnect", handler: EventHandler<void>): void;
  on(event: "reconnect", handler: EventHandler<HelloOk>): void;
  on(
    event: "permissionRequired",
    handler: EventHandler<PermissionRequiredData>,
  ): void;
  on(
    event:
      | "message"
      | "rawEvent"
      | "disconnect"
      | "reconnect"
      | "permissionRequired",
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
      case "permissionRequired":
        this.permissionRequiredHandlers.push(
          handler as EventHandler<PermissionRequiredData>,
        );
        break;
    }
  }

  // --- RPC passthrough ---

  async sendRpc(method: string, params?: unknown): Promise<unknown> {
    if (!this.client) throw new Error("Not connected");
    return this.client.sendRpc(method, params);
  }

  async grantPermission(params: {
    sessionId: string;
    agentId: string;
    resource: string;
    access: string[];
  }): Promise<void> {
    await this.sendRpc("permissions/grant", params);
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
      this.conversations.set(conversationId, {
        id: res.conversation.id,
        type: res.conversation.type,
        name: res.conversation.name,
        participants: res.participants.map(
          (p) => `${p.participant.type}:${p.participant.id}`,
        ),
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
        if (!this.agentNames.has(msg.senderId)) {
          void this.resolveAgentName(msg.senderId);
        }
        // Emit to external handlers (only non-own messages)
        if (msg.senderId !== this.ownAgentId) {
          for (const h of this.messageHandlers) h(msg);
        }
        break;
      }
      case EventNames.PermissionsRequired: {
        const data = event.data as PermissionRequiredData;
        for (const h of this.permissionRequiredHandlers) h(data);
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
    this.messages.set(msg.conversationId, buf);
  }

  private resolveSenderLabel(senderId: string): string {
    return this.agentNames.get(senderId) ?? senderId;
  }
}
