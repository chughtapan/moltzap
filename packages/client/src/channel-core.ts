/**
 * Shared message-enrichment helper for MoltZap channel adapters.
 */

import { Cause, Chunk, Duration, Effect, Fiber, Queue } from "effect";
import type { Message, PermissionsRequiredEvent } from "@moltzap/protocol";
import type {
  CrossConversationEntry,
  CrossConvMessage,
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
  /**
   * Present when multiple queued messages from the same conversation were
   * coalesced into this single dispatch. Includes the primary message first.
   */
  coalescedMessages?: ReadonlyArray<{
    id: string;
    sender: EnrichedSender;
    text: string;
    createdAt: string;
    replyToId?: string;
  }>;
}

export interface PendingDispatchMessage {
  messageId: string;
  conversationId: string;
  senderAgentId: string;
  createdAt: string;
  receivedAt: string;
}

export interface DispatchAdmissionRequest {
  message: Message;
  conversationId: string;
  senderAgentId: string;
  attempt: number;
  receivedAt: string;
  pending: ReadonlyArray<PendingDispatchMessage>;
}

export type DispatchAdmissionDecision =
  | { _tag: "grant"; leaseId?: string }
  | { _tag: "defer"; retryAfterMs: number; reason?: string }
  | { _tag: "deny"; reason?: string };

/** The subset of MoltZapService that MoltZapChannelCore needs. */
export interface ChannelService {
  readonly ownAgentId: string | undefined;
  on(event: "message", handler: (msg: Message) => void): void;
  on(event: "disconnect", handler: () => void): void;
  on(event: "reconnect", handler: () => void): void;
  on(
    event: "permissionRequired",
    handler: (data: PermissionsRequiredEvent) => void,
  ): void;
  connect(): Effect.Effect<unknown, ServiceRpcError>;
  close(): void;
  send(
    conversationId: string,
    text: string,
    opts?: { dispatchLeaseId?: string },
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
  authorizeDispatch?(
    request: DispatchAdmissionRequest,
  ): Effect.Effect<DispatchAdmissionDecision, ServiceRpcError>;
}

export interface ChannelCoreOptions {
  service: ChannelService;
  logger?: WsClientLogger;
  dispatchAdmissionTimeoutMs?: number;
}

/**
 * Handler invoked for every enriched inbound message. Returns an Effect so the
 * error channel is part of the type — callers fail with a tagged error and the
 * consumer fiber logs it instead of dropping it on the floor like a Promise
 * rejection would.
 */
export type InboundHandler<E = unknown> = (
  msg: EnrichedInboundMessage,
) => Effect.Effect<void, E>;

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const DEFAULT_DISPATCH_ADMISSION_TIMEOUT_MS = 1000;

function errorSummary(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      errorName: err.name,
      errorMessage: err.message,
      errorStack: err.stack,
    };
  }
  return {
    errorValue: String(err),
  };
}

interface InboundDispatchWork {
  message: Message;
  attempt: number;
  receivedAtMs: number;
}

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
  private readonly dispatchAdmissionTimeoutMs: number;
  private connected = false;
  private inboundHandler: InboundHandler<unknown> | null = null;
  private activeDispatchLeaseId: string | undefined;
  /** Inbound messages enqueue synchronously; a single forked consumer fiber
   * serialises delivery so handlers execute one-at-a-time in arrival order. */
  private readonly inboundQueue: Queue.Queue<InboundDispatchWork> =
    Effect.runSync(Queue.unbounded<InboundDispatchWork>());
  private readonly consumerFiber: Fiber.RuntimeFiber<void, never>;
  private disconnectHandlers: Array<() => void> = [];
  private reconnectHandlers: Array<() => void> = [];
  private permissionRequiredHandler:
    | ((data: PermissionsRequiredEvent) => void)
    | null = null;

  constructor(opts: ChannelCoreOptions) {
    this.service = opts.service;
    this.logger = opts.logger ?? noopLogger;
    this.dispatchAdmissionTimeoutMs =
      opts.dispatchAdmissionTimeoutMs ?? DEFAULT_DISPATCH_ADMISSION_TIMEOUT_MS;

    this.service.on("message", (message) => {
      Queue.unsafeOffer(this.inboundQueue, {
        message,
        attempt: 0,
        receivedAtMs: Date.now(),
      });
    });

    // Both typed failures (Effect.fail) and defects (sync throws inside the
    // handler's Effect) are caught — Cause.squash collapses either into a
    // single value for the logger so the consumer fiber survives a misbehaving
    // handler in either mode.
    const consumer = Effect.forever(
      Queue.take(this.inboundQueue).pipe(
        Effect.flatMap((work) =>
          this.dispatchInboundWork(work).pipe(
            Effect.catchAllCause((cause) =>
              Effect.sync(() =>
                this.logger.error(
                  {
                    messageId: work.message.id,
                    conversationId: work.message.conversationId,
                    causePretty: Cause.pretty(cause),
                    ...errorSummary(Cause.squash(cause)),
                  },
                  "MoltZapChannelCore: inbound handler failed",
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
  onInbound<E>(handler: InboundHandler<E>): void {
    this.inboundHandler = handler as InboundHandler<unknown>;
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandlers.push(handler);
  }

  onReconnect(handler: () => void): void {
    this.reconnectHandlers.push(handler);
  }

  onPermissionRequired(
    handler: (data: PermissionsRequiredEvent) => void,
  ): void {
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
    return this.service.send(conversationId, text, {
      dispatchLeaseId: this.activeDispatchLeaseId,
    });
  }

  private dispatchAdmission(
    work: InboundDispatchWork,
  ): Effect.Effect<DispatchAdmissionDecision, ServiceRpcError> {
    if (!this.service.authorizeDispatch) {
      return Effect.succeed({ _tag: "grant" });
    }
    return Effect.suspend(() =>
      this.service.authorizeDispatch!({
        message: work.message,
        conversationId: work.message.conversationId,
        senderAgentId: work.message.senderId,
        attempt: work.attempt,
        receivedAt: new Date(work.receivedAtMs).toISOString(),
        pending: this.pendingDispatchSnapshot(work),
      }),
    ).pipe(
      Effect.timeoutFail({
        duration: Duration.millis(this.dispatchAdmissionTimeoutMs),
        onTimeout: () =>
          new Error(
            `dispatch admission timed out after ${this.dispatchAdmissionTimeoutMs}ms`,
          ),
      }),
      Effect.catchAll((err) =>
        Effect.sync(() => {
          this.logger.warn(
            {
              messageId: work.message.id,
              conversationId: work.message.conversationId,
              attempt: work.attempt,
              err,
            },
            "MoltZapChannelCore: dispatch admission failed open",
          );
          return { _tag: "grant" as const };
        }),
      ),
    );
  }

  private dispatchInboundWork(
    work: InboundDispatchWork,
  ): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      const decision = yield* this.dispatchAdmission(work);
      if (decision._tag === "grant") {
        const messages = this.service.authorizeDispatch
          ? yield* this.takeCoalescedConversationMessages(work)
          : [work.message];
        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            const previous = this.activeDispatchLeaseId;
            this.activeDispatchLeaseId = decision.leaseId;
            return previous;
          }),
          () => this.dispatchInboundEffect(messages),
          (previous) =>
            Effect.sync(() => {
              this.activeDispatchLeaseId = previous;
            }),
        );
        return;
      }

      if (decision._tag === "deny") {
        yield* Effect.sync(() =>
          this.logger.info(
            {
              messageId: work.message.id,
              conversationId: work.message.conversationId,
              attempt: work.attempt,
              reason: decision.reason,
            },
            "MoltZapChannelCore: inbound dispatch denied",
          ),
        );
        return;
      }

      const retryAfterMs = Math.max(0, Math.floor(decision.retryAfterMs));
      yield* Effect.sync(() =>
        this.logger.info(
          {
            messageId: work.message.id,
            conversationId: work.message.conversationId,
            attempt: work.attempt,
            retryAfterMs,
            reason: decision.reason,
          },
          "MoltZapChannelCore: inbound dispatch deferred",
        ),
      );
      yield* Effect.sleep(Duration.millis(retryAfterMs));
      yield* this.dispatchInboundWork({
        ...work,
        attempt: work.attempt + 1,
      });
    });
  }

  private pendingDispatchSnapshot(
    active: InboundDispatchWork,
  ): ReadonlyArray<PendingDispatchMessage> {
    const queued = Chunk.toReadonlyArray(
      Effect.runSync(Queue.takeAll(this.inboundQueue)),
    );
    for (const work of queued) {
      Queue.unsafeOffer(this.inboundQueue, work);
    }
    return [active, ...queued].map((work) => ({
      messageId: work.message.id,
      conversationId: work.message.conversationId,
      senderAgentId: work.message.senderId,
      createdAt: work.message.createdAt,
      receivedAt: new Date(work.receivedAtMs).toISOString(),
    }));
  }

  private takeCoalescedConversationMessages(
    work: InboundDispatchWork,
  ): Effect.Effect<ReadonlyArray<Message>, never> {
    return Effect.sync(() => {
      const queued = Chunk.toReadonlyArray(
        Effect.runSync(Queue.takeAll(this.inboundQueue)),
      );
      const coalesced: Message[] = [work.message];
      const remaining: InboundDispatchWork[] = [];
      for (const queuedWork of queued) {
        if (queuedWork.message.conversationId === work.message.conversationId) {
          coalesced.push(queuedWork.message);
        } else {
          remaining.push(queuedWork);
        }
      }
      for (const remainingWork of remaining) {
        Queue.unsafeOffer(this.inboundQueue, remainingWork);
      }
      return coalesced;
    });
  }

  /**
   * Stateless enrichment helper. Falls back to `sender.id` if
   * `resolveAgentName` throws (e.g. service not yet connected).
   */
  static enrichMessage(
    service: ChannelService,
    messageOrMessages: Message | ReadonlyArray<Message>,
  ): Effect.Effect<
    {
      enriched: EnrichedInboundMessage;
      commitContext?: () => void;
    },
    never
  > {
    return Effect.gen(function* () {
      const messages = Array.isArray(messageOrMessages)
        ? [...messageOrMessages]
        : [messageOrMessages];
      const message = messages[0]!;
      const convMeta = service.getConversation(message.conversationId);

      const senderNameFor = (agentId: string) => {
        const cachedName = service.getAgentName(agentId);
        // `resolveAgentName` has `never` in the error channel — it catches its
        // own transport failures and falls back to `senderId` internally, so
        // no explicit `catchAll` is needed here.
        return cachedName !== undefined
          ? Effect.succeed(cachedName)
          : service.resolveAgentName(agentId);
      };

      const senderName = yield* senderNameFor(message.senderId);

      const coalesced = [];
      for (const [index, m] of messages.entries()) {
        const name =
          index === 0 ? senderName : yield* senderNameFor(m.senderId);
        coalesced.push({
          id: m.id,
          sender: {
            id: m.senderId,
            name,
          },
          text: extractTextContent(m.parts),
          createdAt: m.createdAt,
          ...(m.replyToId ? { replyToId: m.replyToId } : {}),
        });
      }

      const text =
        coalesced.length === 1
          ? coalesced[0]!.text
          : coalesced
              .map((m, index) =>
                index === 0
                  ? m.text
                  : `[queued message from ${m.sender.name} at ${m.createdAt}]\n${m.text}`,
              )
              .join("\n\n");

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
          ...(coalesced.length > 1 ? { coalescedMessages: coalesced } : {}),
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

  private dispatchInboundEffect(
    messages: ReadonlyArray<Message>,
  ): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      if (!this.inboundHandler) return;
      const { enriched, commitContext } =
        yield* MoltZapChannelCore.enrichMessage(this.service, messages);
      // The handler is user code returning an Effect — yield it directly so
      // its typed error channel propagates to the consumer fiber, which logs
      // and continues. We await it inline to preserve arrival-order delivery.
      yield* this.inboundHandler(enriched);
      if (commitContext) commitContext();
    });
  }
}
