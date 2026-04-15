/**
 * Shared message-enrichment helper for MoltZap channel adapters.
 */

import type { Message } from "@moltzap/protocol";
import type {
  CrossConversationEntry,
  CrossConvMessage,
  PermissionRequiredData,
} from "./service.js";
import type { WsClientLogger } from "./ws-client.js";

export interface EnrichedSender {
  id: string;
  name: string;
}

export interface EnrichedConversationMeta {
  type: "dm" | "group";
  name?: string;
  /** "type:id" strings (e.g. "agent:uuid"). */
  participants: string[];
}

export interface ContextBlocks {
  groupMetadata?: EnrichedConversationMeta;
  crossConversation?: CrossConversationEntry[];
  crossConversationMessages?: CrossConvMessage[];
}

export interface EnrichedInboundMessage {
  id: string;
  conversationId: string;
  sender: EnrichedSender;
  /** Text parts joined with newlines. Non-text parts dropped. */
  text: string;
  isFromMe: boolean;
  createdAt: string;
  replyToId?: string;
  conversationMeta?: EnrichedConversationMeta;
  contextBlocks: ContextBlocks;
}

/** The subset of MoltZapService that MoltZapChannelCore needs. */
export interface ChannelService {
  readonly ownAgentId: string | undefined;
  on(event: "message", handler: (msg: Message) => void): void;
  on(event: "disconnect", handler: () => void): void;
  on(event: "reconnect", handler: () => void): void;
  on(
    event: "permissionRequired",
    handler: (data: PermissionRequiredData) => void,
  ): void;
  connect(): Promise<unknown>;
  close(): void;
  send(conversationId: string, text: string): Promise<void>;
  getConversation(
    convId: string,
  ): { type: string; name?: string; participants: string[] } | undefined;
  getAgentName(agentId: string): string | undefined;
  resolveAgentName(agentId: string): Promise<string>;
  peekContextEntries(
    currentConvId: string,
    opts?: { maxConversations?: number; maxMessagesPerConv?: number },
  ): { entries: CrossConversationEntry[]; commit: () => void };
  peekFullMessages(currentConvId: string): {
    messages: CrossConvMessage[];
    commit: () => void;
  };
}

export interface ChannelCoreOptions {
  service: ChannelService;
  logger?: WsClientLogger;
}

export type InboundHandler = (
  msg: EnrichedInboundMessage,
) => Promise<void> | void;

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function extractTextContent(parts: Message["parts"]): string {
  return parts
    .filter(
      (p): p is Extract<Message["parts"][number], { type: "text" }> =>
        p.type === "text",
    )
    .map((p) => p.text)
    .join("\n");
}

/**
 * Wraps a MoltZapService with message enrichment, dispatch-chain ordering,
 * and a send helper.
 *
 * Do NOT construct multiple cores over the same service — getContextEntries()
 * is side-effectful (advances per-conversation markers), so a second core
 * would consume entries the first expected.
 */
export class MoltZapChannelCore {
  private readonly service: ChannelService;
  private readonly logger: WsClientLogger;
  private connected = false;
  private inboundHandler: InboundHandler | null = null;
  private dispatchChain: Promise<void> = Promise.resolve();
  private disconnectHandlers: Array<() => void> = [];
  private reconnectHandlers: Array<() => void> = [];
  private permissionRequiredHandler:
    | ((data: PermissionRequiredData) => void)
    | null = null;

  constructor(opts: ChannelCoreOptions) {
    this.service = opts.service;
    this.logger = opts.logger ?? noopLogger;

    this.service.on("message", (message) => {
      this.dispatchChain = this.dispatchChain
        .then(() => this.handleInbound(message))
        .catch((err) => {
          this.logger.error(
            { messageId: message.id, err },
            "MoltZapChannelCore: inbound handler threw",
          );
        });
    });

    this.service.on("disconnect", () => {
      this.connected = false;
      for (const h of this.disconnectHandlers) h();
    });

    this.service.on("reconnect", () => {
      this.connected = true;
      for (const h of this.reconnectHandlers) h();
    });

    this.service.on("permissionRequired", (data) => {
      if (this.permissionRequiredHandler) {
        this.permissionRequiredHandler(data);
      }
    });
  }

  /** Replaces any previous handler. */
  onInbound(handler: InboundHandler): void {
    this.inboundHandler = handler;
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandlers.push(handler);
  }

  onReconnect(handler: () => void): void {
    this.reconnectHandlers.push(handler);
  }

  onPermissionRequired(handler: (data: PermissionRequiredData) => void): void {
    this.permissionRequiredHandler = handler;
  }

  async connect(): Promise<void> {
    await this.service.connect();
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.service.close();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async sendReply(conversationId: string, text: string): Promise<void> {
    await this.service.send(conversationId, text);
  }

  /**
   * Stateless enrichment helper. Falls back to `sender.id` if
   * `resolveAgentName` throws (e.g. service not yet connected).
   */
  static async enrichMessage(
    service: ChannelService,
    message: Message,
  ): Promise<{
    enriched: EnrichedInboundMessage;
    commitContext?: () => void;
  }> {
    const convMeta = service.getConversation(message.conversationId);

    const senderName =
      service.getAgentName(message.senderId) ??
      (await service
        .resolveAgentName(message.senderId)
        .catch(() => message.senderId));

    const text = extractTextContent(message.parts);

    const isFromMe =
      service.ownAgentId !== undefined &&
      message.senderId === service.ownAgentId;

    const conversationMeta: EnrichedConversationMeta | undefined = convMeta
      ? {
          type: convMeta.type === "group" ? "group" : "dm",
          name: convMeta.name,
          participants: convMeta.participants,
        }
      : undefined;

    const contextBlocks: ContextBlocks = {};

    if (conversationMeta?.type === "group") {
      contextBlocks.groupMetadata = conversationMeta;
    }

    const { entries, commit: commitLegacy } = service.peekContextEntries(
      message.conversationId,
    );
    if (entries.length > 0) {
      contextBlocks.crossConversation = entries;
    }

    const { messages: fullMessages, commit: commitFull } =
      service.peekFullMessages(message.conversationId);
    if (fullMessages.length > 0) {
      contextBlocks.crossConversationMessages = fullMessages;
    }

    const hasContext = entries.length > 0 || fullMessages.length > 0;

    return {
      enriched: {
        id: message.id,
        conversationId: message.conversationId,
        sender: {
          id: message.senderId,
          name: senderName,
        },
        text,
        isFromMe,
        createdAt: message.createdAt,
        replyToId: message.replyToId,
        conversationMeta,
        contextBlocks,
      },
      commitContext: hasContext
        ? () => {
            commitLegacy();
            commitFull();
          }
        : undefined,
    };
  }

  private async handleInbound(message: Message): Promise<void> {
    if (!this.inboundHandler) return;
    const { enriched, commitContext } = await MoltZapChannelCore.enrichMessage(
      this.service,
      message,
    );
    await this.inboundHandler(enriched);
    commitContext?.();
  }
}
