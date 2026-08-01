/**
 * Shared message-enrichment helper for MoltZap channel adapters.
 */

import { Cause, Chunk, Duration, Effect, Fiber, Option, Queue } from "effect";
import type { ConversationId } from "@moltzap/protocol/conversation";
import type { Message } from "@moltzap/protocol/message";
import type {
  CrossConversationEntry,
  CrossConvMessage,
  ServiceRpcError,
} from "./service.js";
import { enrichChannelMessage } from "./channel-core-enrichment.js";

/** Describes enriched sender. */
export interface EnrichedSender {
  id: string;
  name: string;
}

/** Describes enriched conversation meta. */
export interface EnrichedConversationMeta {
  type: "dm" | "group";
  name?: string;
  /** "type:id" strings (e.g. "agent:uuid"). */
  participants: string[];
}

/** Describes context blocks. */
export interface ContextBlocks {
  groupMetadata?: EnrichedConversationMeta;
  crossConversation?: CrossConversationEntry[];
  crossConversationMessages?: CrossConvMessage[];
}

/** Describes enriched inbound message. */
export interface EnrichedInboundMessage {
  id: string;
  conversationId: ConversationId;
  sender: EnrichedSender;
  /** Text parts joined with newlines. Non-text parts dropped. */
  text: string;
  isFromMe: boolean;
  createdAt: string;
  conversationMeta?: EnrichedConversationMeta;
  contextBlocks: ContextBlocks;

  /**
   * Present when multiple queued messages from the same conversation were
   * coalesced into this single turn. Includes the primary message first.
   */
  coalescedMessages?: ReadonlyArray<{
    id: string;
    sender: EnrichedSender;
    text: string;
    createdAt: string;
  }>;
}

/** The subset of MoltZapService that MoltZapChannelCore needs. */
export interface ChannelService {
  readonly ownAgentId?: string;
  on(event: "message", handler: (payload: { message: Message }) => void): void;
  on(event: "disconnect", handler: () => void): void;
  connect(): Effect.Effect<unknown, ServiceRpcError>;
  close(): void;
  send(
    conversationId: ConversationId,
    text: string,
  ): Effect.Effect<void, ServiceRpcError>;
  getConversation(
    convId: string,
  ): { type: string; name?: string; participants: string[] } | undefined;
  getAgentName(agentId: string): string | undefined;
  resolveAgentName(agentId: string): Effect.Effect<string>;
  peekContextEntries(
    currentConvId: string,
    opts?: { maxConversations?: number; maxMessagesPerConv?: number },
  ): { entries: CrossConversationEntry[]; commit: () => void };
  peekFullMessages(currentConvId: string): {
    messages: CrossConvMessage[];
    commit: () => void;
  };
}

/** Configures channel core. */
export interface ChannelCoreOptions {
  service: ChannelService;

  /**
   * Wall-clock bound on one inbound turn. On expiry the turn is abandoned
   * and the consumer keeps draining.
   *
   * Unset means unbounded, which is the safe default for runtimes whose
   * turns legitimately run for minutes: nothing else can interrupt the
   * handler, so a bound that is too tight silently drops real work. The
   * cost of leaving it unset is that a hung handler stalls the serial
   * drain forever — set it for runtimes that can wedge.
   */
  turnTimeoutMs?: number;
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

function effectLogWarning(
  message: string,
  annotations: Record<string, unknown>,
): Effect.Effect<void> {
  return Effect.logWarning(message).pipe(Effect.annotateLogs(annotations));
}

function effectLogError(
  message: string,
  annotations: Record<string, unknown>,
): Effect.Effect<void> {
  return Effect.logError(message).pipe(Effect.annotateLogs(annotations));
}

function runBackgroundLog(effect: Effect.Effect<void>): void {
  Effect.runFork(effect);
}

/**
 * Wraps a `MoltZapService` with message enrichment, one-turn-at-a-time
 * inbound delivery, and a send helper. One core per service —
 * `getContextEntries()` is side-effectful (advances per-conversation
 * markers), so a second core would consume entries the first expected.
 *
 * Turn-taking is entirely endpoint-local: the server delivers every message
 * it accepts, and this core decides when the runtime sees them.
 *
 * Inbound path from wire bytes to user handler:.
 *
 * ```mermaid
 * sequenceDiagram
 *   participant server
 *   participant ws as MoltZapAgentClient
 *   participant svc as MoltZapService
 *   participant core as MoltZapChannelCore
 *   participant handler as InboundHandler
 *
 *   server->>ws: agent/message/received notification
 *   ws->>svc: subscribers.dispatch — fanout(message)
 *   svc->>core: message listener
 *   Note over core: dedup via recordMessageIdIfNew; Queue.unsafeOffer(inboundQueue, message)
 *   Note over core: consumer fiber — Queue.take
 *   Note over core: takeCoalescedConversationMessages drains same-conv backlog into one turn
 *   Note over core: enrichMessage — sender name, conversation, context entries
 *   core->>handler: inboundHandler(enriched)
 *   handler-->>core: Effect.void
 *   Note over core: handler exceeds turnTimeoutMs — turn abandoned, drain continues
 * ```
 *
 * The single consumer fiber awaits the handler inline, so at most one turn
 * runs at a time and messages that arrive mid-turn wait in the queue.
 */
export class MoltZapChannelCore {
  private readonly service: ChannelService;
  private readonly turnTimeoutMs?: number;
  private connected = false;
  private inboundHandler: InboundHandler | null = null;

  /**
   * Inbound messages enqueue synchronously; a single forked consumer fiber
   * serialises delivery so handlers execute one-at-a-time in arrival order.
   */
  private readonly inboundQueue: Queue.Queue<Message> = Effect.runSync(
    Queue.unbounded<Message>(),
  );
  private readonly consumerFiber: Fiber.RuntimeFiber<void>;
  private readonly disconnectHandlers: Array<() => void> = [];

  constructor(opts: ChannelCoreOptions) {
    this.service = opts.service;
    if (opts.turnTimeoutMs !== undefined) {
      this.turnTimeoutMs = opts.turnTimeoutMs;
    }

    this.registerMessageListener();
    this.consumerFiber = this.startConsumerFiber();
    this.registerConnectionListeners();
  }

  private registerMessageListener(): void {
    this.service.on("message", ({ message }) => {
      Queue.unsafeOffer(this.inboundQueue, message);
    });
  }

  private startConsumerFiber(): Fiber.RuntimeFiber<void> {
    const consumer = Effect.forever(
      Queue.take(this.inboundQueue).pipe(
        Effect.flatMap((message) =>
          this.runInboundTurn(message).pipe(
            Effect.catchAllCause((cause) =>
              this.logInboundFailure(message, cause),
            ),
          ),
        ),
      ),
    );
    return Effect.runFork(consumer);
  }

  private logInboundFailure(
    message: Message,
    cause: Cause.Cause<unknown>,
  ): Effect.Effect<void> {
    return effectLogError("MoltZapChannelCore: inbound handler failed", {
      messageId: message.id,
      conversationId: message.conversationId,
      causePretty: Cause.pretty(cause),
      ...errorSummary(Cause.squash(cause)),
    });
  }

  private registerConnectionListeners(): void {
    this.service.on("disconnect", () => {
      this.connected = false;
      this.fanout(this.disconnectHandlers, "disconnect");
    });
  }

  /**
   * Replaces any previous handler.
   * @param handler Handler invoked for matching requests.
   */
  onInbound<E>(handler: InboundHandler<E>): void {
    this.inboundHandler = handler;
  }

  onDisconnect(handler: () => void): void {
    this.disconnectHandlers.push(handler);
  }

  private fanout(handlers: ReadonlyArray<() => void>, label: string): void {
    for (const h of handlers) {
      try {
        h();
      } catch (err) {
        runBackgroundLog(
          effectLogError(`MoltZapChannelCore: ${label} handler threw`, {
            err,
            label,
          }),
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

  disconnect(): Effect.Effect<void> {
    return Effect.gen(
      function* (this: MoltZapChannelCore) {
        this.service.close();
        this.connected = false;
        // Interrupt the consumer fiber so any queued inbound messages are
        // dropped rather than delivered after the channel is torn down.
        yield* Fiber.interrupt(this.consumerFiber);
      }.bind(this),
    );
  }

  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Reply into a conversation.
   * @param conversationId Value supplied to the operation.
   * @param text Text to process.
   * @returns The send result.
   */
  sendReply(
    conversationId: ConversationId,
    text: string,
  ): Effect.Effect<void, ServiceRpcError> {
    return this.service.send(conversationId, text);
  }

  private runInboundTurn(primary: Message): Effect.Effect<void, unknown> {
    return Effect.gen(
      function* (this: MoltZapChannelCore) {
        const messages = yield* this.takeCoalescedConversationMessages(primary);
        const turn = this.dispatchInboundEffect(messages);
        const timeoutMs = this.turnTimeoutMs;
        if (timeoutMs === undefined) {
          yield* turn;
          return;
        }
        const finished = yield* turn.pipe(
          Effect.timeoutOption(Duration.millis(timeoutMs)),
        );
        if (Option.isNone(finished)) {
          yield* effectLogWarning(
            "MoltZapChannelCore: inbound turn abandoned after timeout",
            {
              messageId: primary.id,
              conversationId: primary.conversationId,
              timeoutMs,
            },
          );
        }
      }.bind(this),
    );
  }

  /**
   * Drain every queued message for the primary's conversation into one turn,
   * leaving other conversations queued in arrival order. Coalescing keeps a
   * burst in one conversation from costing one turn per message.
   * @param primary Message that opened this turn.
   * @returns The messages belonging to this turn, primary first.
   */
  private takeCoalescedConversationMessages(
    primary: Message,
  ): Effect.Effect<readonly Message[]> {
    return Effect.sync(() => {
      const queued = Chunk.toReadonlyArray(
        Effect.runSync(Queue.takeAll(this.inboundQueue)),
      );
      const sameConversation: Message[] = [primary];
      const remaining: Message[] = [];
      for (const queuedMessage of queued) {
        if (queuedMessage.conversationId === primary.conversationId) {
          sameConversation.push(queuedMessage);
        } else {
          remaining.push(queuedMessage);
        }
      }
      for (const remainingMessage of remaining) {
        Queue.unsafeOffer(this.inboundQueue, remainingMessage);
      }
      return sameConversation;
    });
  }

  /**
   * Stateless enrichment helper. Falls back to `sender.id` if
   * `resolveAgentName` throws (e.g. Service not yet connected).
   * @param service Value supplied to the operation.
   * @param messageOrMessages Value supplied to the operation.
   * @returns The enriched message and its context-commit callback.
   */
  static enrichMessage(
    service: ChannelService,
    messageOrMessages: Message | readonly Message[],
  ): Effect.Effect<{
    enriched: EnrichedInboundMessage;
    commitContext?: () => void;
  }> {
    return enrichChannelMessage(service, messageOrMessages);
  }

  private dispatchInboundEffect(
    messages: readonly Message[],
  ): Effect.Effect<void, unknown> {
    return Effect.gen(
      function* (this: MoltZapChannelCore) {
        if (!this.inboundHandler) {
          return;
        }
        const { enriched, commitContext } =
          yield* MoltZapChannelCore.enrichMessage(this.service, messages);
        // The handler is user code returning an Effect — yield it directly so
        // its typed error channel propagates to the consumer fiber, which logs
        // and continues. We await it inline to preserve arrival-order delivery.
        yield* this.inboundHandler(enriched);
        if (commitContext) {
          commitContext();
        }
      }.bind(this),
    );
  }
}
