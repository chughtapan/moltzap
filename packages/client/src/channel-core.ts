/**
 * Shared message-enrichment helper for MoltZap channel adapters.
 */

import type { Message } from "@moltzap/protocol";
import type { CrossConversationEntry, CrossConvMessage } from "./service.js";
import type { WsClientLogger } from "./ws-client.js";
import { telemetry, SCHEMA_VERSION } from "@moltzap/observability";

export interface EnrichedSender {
  type: "agent" | "user";
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
  /**
   * Milliseconds between `queue.stats` telemetry emissions. Default 5000.
   * Set to 0 to disable the periodic stats timer (useful in tests).
   */
  queueStatsIntervalMs?: number;
}

/**
 * Rollups need to distinguish "agent replied" from "agent received but chose
 * not to respond." Returning void or undefined maps to outcome "final"
 * (backwards-compatible for handlers predating this contract).
 */
export interface InboundHandlerResult {
  outcome: "final" | "skipped";
}

export type InboundHandler = (
  msg: EnrichedInboundMessage,
) => Promise<void | InboundHandlerResult> | void | InboundHandlerResult;

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
export interface QueueStats {
  depth: number;
  inflight: number;
  oldestQueuedAgeMs?: number;
}

export class MoltZapChannelCore {
  private readonly service: ChannelService;
  private readonly logger: WsClientLogger;
  private connected = false;
  private inboundHandler: InboundHandler | null = null;
  private dispatchChain: Promise<void> = Promise.resolve();
  private disconnectHandlers: Array<() => void> = [];
  private reconnectHandlers: Array<() => void> = [];

  private inflight = 0;
  private enqueuedAt = new Map<string, number>();
  private queueStatsTimer: NodeJS.Timeout | null = null;
  private lastEmittedStats: { depth: number; inflight: number } | null = null;
  private readonly queueStatsIntervalMs: number;

  constructor(opts: ChannelCoreOptions) {
    this.service = opts.service;
    this.logger = opts.logger ?? noopLogger;
    this.queueStatsIntervalMs = opts.queueStatsIntervalMs ?? 5000;

    this.service.on("message", (message) => {
      const agentId = this.service.ownAgentId;
      this.enqueuedAt.set(message.id, Date.now());

      const startHandler = async (): Promise<void> => {
        const dispatchStartedAt = Date.now();
        this.inflight++;
        if (agentId) {
          telemetry.emit({
            event: "dispatch.start",
            source: "agent",
            schemaVersion: SCHEMA_VERSION,
            ts: dispatchStartedAt,
            msgId: message.id,
            convId: message.conversationId,
            agentId,
            queueDepth: this.enqueuedAt.size,
            inflight: this.inflight,
          });
        }
        let outcome: "final" | "skipped" | "error" = "final";
        let errorReason: string | undefined;
        try {
          const result = await this.handleInbound(message);
          if (result?.outcome === "skipped") outcome = "skipped";
        } catch (err) {
          outcome = "error";
          errorReason = err instanceof Error ? err.message : String(err);
          this.logger.error(
            { messageId: message.id, err },
            "MoltZapChannelCore: inbound handler threw",
          );
        } finally {
          this.inflight--;
          this.enqueuedAt.delete(message.id);
          if (agentId) {
            telemetry.emit({
              event: "dispatch.complete",
              source: "agent",
              schemaVersion: SCHEMA_VERSION,
              ts: Date.now(),
              msgId: message.id,
              convId: message.conversationId,
              agentId,
              durationMs: Date.now() - dispatchStartedAt,
              outcome,
              errorReason,
            });
          }
        }
      };

      this.dispatchChain = this.dispatchChain.then(startHandler);
    });

    this.service.on("disconnect", () => {
      this.connected = false;
      this.stopQueueStatsTimer();
      for (const h of this.disconnectHandlers) h();
    });

    this.service.on("reconnect", () => {
      this.connected = true;
      this.startQueueStatsTimer();
      for (const h of this.reconnectHandlers) h();
    });
  }

  private startQueueStatsTimer(): void {
    if (this.queueStatsTimer !== null) return;
    if (this.queueStatsIntervalMs <= 0) return;
    this.queueStatsTimer = setInterval(() => {
      const agentId = this.service.ownAgentId;
      if (!agentId) return;
      const stats = this.getQueueStats();
      // Only emit when state changes. Skip duplicate zero heartbeats for
      // idle agents; emit exactly one "back to zero" transition.
      const last = this.lastEmittedStats;
      if (
        last &&
        last.depth === stats.depth &&
        last.inflight === stats.inflight
      ) {
        return;
      }
      this.lastEmittedStats = { depth: stats.depth, inflight: stats.inflight };
      telemetry.emit({
        event: "queue.stats",
        source: "agent",
        schemaVersion: SCHEMA_VERSION,
        ts: Date.now(),
        agentId,
        depth: stats.depth,
        inflight: stats.inflight,
        oldestQueuedAgeMs: stats.oldestQueuedAgeMs,
      });
    }, this.queueStatsIntervalMs);
    this.queueStatsTimer.unref?.();
  }

  private stopQueueStatsTimer(): void {
    if (this.queueStatsTimer !== null) {
      clearInterval(this.queueStatsTimer);
      this.queueStatsTimer = null;
    }
  }

  getQueueStats(): QueueStats {
    let oldestQueuedAgeMs: number | undefined;
    if (this.enqueuedAt.size > 0) {
      const now = Date.now();
      let oldest = now;
      for (const t of this.enqueuedAt.values()) {
        if (t < oldest) oldest = t;
      }
      oldestQueuedAgeMs = now - oldest;
    }
    return {
      depth: this.enqueuedAt.size,
      inflight: this.inflight,
      oldestQueuedAgeMs,
    };
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

  async connect(): Promise<void> {
    await this.service.connect();
    this.connected = true;
    this.startQueueStatsTimer();
  }

  async disconnect(): Promise<void> {
    this.stopQueueStatsTimer();
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
      service.getAgentName(message.sender.id) ??
      (await service
        .resolveAgentName(message.sender.id)
        .catch(() => message.sender.id));

    const text = extractTextContent(message.parts);

    const isFromMe =
      service.ownAgentId !== undefined &&
      message.sender.id === service.ownAgentId;

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
          type: message.sender.type === "user" ? "user" : "agent",
          id: message.sender.id,
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

  private async handleInbound(
    message: Message,
  ): Promise<void | InboundHandlerResult> {
    if (!this.inboundHandler) return;
    const { enriched, commitContext } = await MoltZapChannelCore.enrichMessage(
      this.service,
      message,
    );
    const result = await this.inboundHandler(enriched);
    commitContext?.();
    return result;
  }
}
