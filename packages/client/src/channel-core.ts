/**
 * Shared message-enrichment helper for MoltZap channel adapters.
 */

import { Effect, Fiber, Queue } from "effect";
import type { Message } from "@moltzap/protocol";
import type {
  CrossConversationEntry,
  CrossConvMessage,
  PermissionRequiredData,
  ServiceRpcError,
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
  connect(): Effect.Effect<unknown, ServiceRpcError>;
  close(): void;
  send(
    conversationId: string,
    text: string,
  ): Effect.Effect<void, ServiceRpcError>;
  getConversation(
    convId: string,
  ): { type: string; name?: string; participants: string[] } | undefined;
  getAgentName(agentId: string): string | undefined;
  resolveAgentName(agentId: string): Effect.Effect<string, never>;
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
  /**
   * Inbound messages are enqueued synchronously from the service's `message`
   * event and consumed by a single forked fiber. This replaces the previous
   * `Promise<void>` chain — same semantics (arrival-order, one handler
   * executes at a time, a throwing handler is logged and does not abort the
   * consumer), but in Effect idiom so the channel core has no raw
   * `Promise.then` ordering machinery.
   */
  private readonly inboundQueue: Queue.Queue<Message> = Effect.runSync(
    Queue.unbounded<Message>(),
  );
  private readonly consumerFiber: Fiber.RuntimeFiber<void, never>;
  private disconnectHandlers: Array<() => void> = [];
  private reconnectHandlers: Array<() => void> = [];
  private permissionRequiredHandler:
    | ((data: PermissionRequiredData) => void)
    | null = null;

  constructor(opts: ChannelCoreOptions) {
    this.service = opts.service;
    this.logger = opts.logger ?? noopLogger;

    this.service.on("message", (message) => {
      // Synchronous enqueue; the consumer fiber serialises delivery.
      Queue.unsafeOffer(this.inboundQueue, message);
    });

    // Long-running daemon that dequeues messages one at a time and awaits
    // each inbound handler to completion. Individual handler failures are
    // caught and logged so the fiber survives for the next message.
    const consumer = Effect.forever(
      Queue.take(this.inboundQueue).pipe(
        Effect.flatMap((message) =>
          this.dispatchInboundEffect(message).pipe(
            Effect.catchAll((err) =>
              Effect.sync(() =>
                this.logger.error(
                  { messageId: message.id, err },
                  "MoltZapChannelCore: inbound handler threw",
                ),
              ),
            ),
          ),
        ),
      ),
    );
    this.consumerFiber = Effect.runFork(consumer);

    this.service.on("disconnect", () => {
      this.connected = false;
      this.fanout(this.disconnectHandlers, "disconnect");
    });

    this.service.on("reconnect", () => {
      this.connected = true;
      this.fanout(this.reconnectHandlers, "reconnect");
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

  private fanout(handlers: ReadonlyArray<() => void>, label: string): void {
    for (const h of handlers) {
      try {
        h();
      } catch (err) {
        this.logger.error(
          { err, label },
          `MoltZapChannelCore: ${label} handler threw`,
        );
      }
    }
  }

  connect(): Effect.Effect<void, ServiceRpcError> {
    return this.service.connect().pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          this.connected = true;
        }),
      ),
      Effect.asVoid,
    );
  }

  disconnect(): Effect.Effect<void, never> {
    return Effect.gen(this, function* () {
      this.service.close();
      this.connected = false;
      // Interrupt the consumer fiber so any queued inbound messages are
      // dropped rather than delivered after the channel is torn down.
      yield* Fiber.interrupt(this.consumerFiber);
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  sendReply(
    conversationId: string,
    text: string,
  ): Effect.Effect<void, ServiceRpcError> {
    return this.service.send(conversationId, text);
  }

  /**
   * Stateless enrichment helper. Falls back to `sender.id` if
   * `resolveAgentName` throws (e.g. service not yet connected).
   */
  static enrichMessage(
    service: ChannelService,
    message: Message,
  ): Effect.Effect<
    {
      enriched: EnrichedInboundMessage;
      commitContext?: () => void;
    },
    never
  > {
    return Effect.gen(function* () {
      const convMeta = service.getConversation(message.conversationId);

      const cachedName = service.getAgentName(message.senderId);
      // `resolveAgentName` has `never` in the error channel — it catches its
      // own transport failures and falls back to `senderId` internally, so
      // no explicit `catchAll` is needed here.
      const senderName =
        cachedName !== undefined
          ? cachedName
          : yield* service.resolveAgentName(message.senderId);

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
    });
  }

  private dispatchInboundEffect(message: Message): Effect.Effect<void, Error> {
    return Effect.gen(this, function* () {
      if (!this.inboundHandler) return;
      const { enriched, commitContext } =
        yield* MoltZapChannelCore.enrichMessage(this.service, message);
      // `inboundHandler` is user code and may return a Promise, so we bridge
      // via `tryPromise` — the consumer fiber awaits this to preserve
      // arrival-order delivery.
      yield* Effect.tryPromise({
        try: () => Promise.resolve(this.inboundHandler!(enriched)),
        catch: (err) => (err instanceof Error ? err : new Error(String(err))),
      });
      if (commitContext) commitContext();
    });
  }
}
