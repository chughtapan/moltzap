/**
 * Channel core: serialized inbound turn delivery over a MoltZapService.
 * Owns the inbound queue, same-conversation coalescing, the interceptor
 * gate, the per-turn timeout, and channel teardown. Enriched adapter delivery
 * uses channel-core-enrichment.ts; raw daemon delivery receives the coalesced
 * Message batch without reading or committing presentation context.
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
  /**
   * Effectful teardown for scoped process owners, which need the service's
   * transports closed before the scope's release completes. Services that
   * only offer the fire-and-forget {@link ChannelService.close} omit it.
   */
  shutdown?(): Effect.Effect<void>;
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
   * Wall-clock bound on one handler invocation. On expiry the turn is
   * abandoned and the consumer keeps draining.
   *
   * Unset means unbounded, which is the safe default for runtimes whose
   * turns legitimately run for minutes: nothing else can interrupt the
   * handler, so a bound that is too tight silently drops real work. The
   * cost of leaving it unset is that a hung handler stalls the serial
   * drain forever — set it for runtimes that can wedge.
   *
   * The bound covers the handler only. Enrichment and
   * {@link ChannelCoreOptions.inboundInterceptor} run outside it.
   */
  turnTimeoutMs?: number;

  /**
   * Endpoint-side gate consulted once per coalesced turn before the selected
   * handler. The enriched path performs enrichment before the gate; the raw
   * path deliberately does not enrich. Unset is passthrough.
   */
  inboundInterceptor?: InboundInterceptor;
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

/**
 * Handler for one coalesced raw inbound turn. The existing Message values are
 * delivered in arrival order after the inbound interceptor admits the batch.
 * Raw delivery does not enrich messages or read and commit presentation
 * context.
 */
export type RawInboundHandler<E = unknown> = (
  messages: readonly Message[],
) => Effect.Effect<void, E>;

type RegisteredInboundHandler =
  | { readonly _tag: "enriched"; readonly handler: InboundHandler }
  | { readonly _tag: "raw"; readonly handler: RawInboundHandler };

/**
 * Verdict an {@link InboundInterceptor} returns for one coalesced turn.
 *
 * The union is closed at deliver and drop on purpose: there is no hold or
 * delay verdict. An interceptor is an Effect, so pacing is expressed by
 * suspending inside it — an ambient Clock sleep, a semaphore, a gate the
 * embedder opens later — and the verdict says only whether the turn runs. A
 * hold verdict would ask the core to park this turn and start the next one,
 * which is the multi-turn concurrency the single consumer fiber exists to
 * prevent.
 */
export type InboundInterceptDecision =
  | { readonly _tag: "deliver" }
  | { readonly _tag: "drop"; readonly reason?: string };

/**
 * Gate the embedder installs between coalescing and the selected handler. The
 * enriched handler path performs enrichment before consulting the gate; the
 * raw handler path does not enrich. The gate receives the newest message of
 * the coalesced batch — a gate deciding whether a turn is still worth running
 * cares about the latest thing said — and its verdict governs the whole batch.
 *
 * It runs on the single consumer fiber, so suspending inside it delays this
 * turn and every message queued behind it, and `turnTimeoutMs` does not bound
 * that suspension. An interceptor that never resumes stalls the drain
 * permanently.
 *
 * A defect, a failure, or a synchronous throw delivers. An embedder bug in a
 * gate must not silently black-hole a production channel: a channel that
 * over-delivers announces itself, one that has gone quiet looks like a network
 * problem for hours.
 */
export type InboundInterceptor = (
  message: Message,
) => Effect.Effect<InboundInterceptDecision>;

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

function effectLogDebug(
  message: string,
  annotations: Record<string, unknown>,
): Effect.Effect<void> {
  return Effect.logDebug(message).pipe(Effect.annotateLogs(annotations));
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
 * Wraps a `MoltZapService` with one-turn-at-a-time inbound delivery and a send
 * helper. Adapter handlers receive enriched messages. A daemon handler may
 * instead receive the admitted coalesced raw Message batch. One core per
 * service — `getContextEntries()` is side-effectful (advances
 * per-conversation markers), so a second core would consume entries the first
 * expected.
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
 *   participant raw as RawInboundHandler
 *   participant enriched as InboundHandler
 *
 *   server->>ws: agent/message/received notification
 *   ws->>svc: subscribers.dispatch — fanout(message)
 *   svc->>core: message listener
 *   Note over core: dedup via recordMessageIdIfNew, drop when stopped or no handler is installed, then Queue.unsafeOffer(inboundQueue, message)
 *   Note over core: consumer fiber — Queue.take
 *   Note over core: takeCoalescedConversationMessages drains same-conv backlog into one turn
 *   alt raw daemon handler
 *     Note over core: inboundInterceptor — deliver or drop this batch
 *     core->>raw: rawInboundHandler(messages)
 *     raw-->>core: Effect.void
 *   else enriched adapter handler
 *     Note over core: enrichMessage — sender name, conversation, context entries
 *     Note over core: inboundInterceptor — deliver or drop this turn
 *     core->>enriched: inboundHandler(enriched)
 *     enriched-->>core: Effect.void
 *     Note over core: completed handler commits presentation context
 *   end
 *   Note over core: handler exceeds turnTimeoutMs — turn abandoned, drain continues
 * ```
 *
 * The single consumer fiber awaits the handler inline, so at most one turn
 * runs at a time and messages that arrive mid-turn wait in the queue.
 */
export class MoltZapChannelCore {
  private readonly service: ChannelService;
  private readonly turnTimeoutMs?: number;
  private readonly inboundInterceptor?: InboundInterceptor;
  private connected = false;
  // Terminal stop: disconnect() interrupts the sole consumer fiber and it is
  // never restarted, while the service deliberately keeps message listeners
  // registered across close()/connect() cycles. Without this flag a
  // reconnected service would keep offering inbound messages into a queue
  // nothing drains — unbounded growth and silent non-delivery. Stopped means
  // stopped: inbound observed after disconnect() is dropped at the listener.
  private stopped = false;
  private inboundHandler: RegisteredInboundHandler | null = null;

  /**
   * Inbound messages with an installed handler enqueue synchronously; a single
   * forked consumer fiber serialises delivery so handlers execute
   * one-at-a-time in arrival order.
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
    if (opts.inboundInterceptor !== undefined) {
      this.inboundInterceptor = opts.inboundInterceptor;
    }

    this.registerMessageListener();
    this.consumerFiber = this.startConsumerFiber();
    this.registerConnectionListeners();
  }

  private registerMessageListener(): void {
    this.service.on("message", ({ message }) => {
      // A core with no handler — a daemon that owns the connection without
      // running a turn loop — observes messages it will never deliver.
      // Dropping here keeps the queue from holding work nothing consumes, and
      // makes the pre-registration window a definite drop rather than a race
      // between the consumer fiber and the embedder's onInbound call.
      if (this.stopped || this.inboundHandler === null) {
        return;
      }
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
    this.inboundHandler = { _tag: "enriched", handler };
  }

  /**
   * Replaces any previous handler with a raw coalesced-turn handler. The
   * admitted batch passes the interceptor and reaches the handler without
   * enrichment or presentation-context commits.
   * @param handler Handler invoked for each admitted raw batch.
   */
  onRawInbound<E>(handler: RawInboundHandler<E>): void {
    this.inboundHandler = { _tag: "raw", handler };
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
    // A stopped core has no consumer fiber and its listener drops every
    // inbound message; reporting a successful connect here would hand the
    // embedder a healthy-looking channel that is permanently deaf. Stopped
    // is terminal — reconnecting means constructing a new core.
    if (this.stopped) {
      return Effect.dieMessage(
        "MoltZapChannelCore.connect called after disconnect; a stopped core cannot be reconnected — construct a new core",
      );
    }
    return this.service.connect().pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          this.connected = true;
        }),
      ),
      Effect.asVoid,
    );
  }

  /**
   * Tear the channel down, resolving only once the service's own transports
   * are closed. A scoped owner releases this before its process exits, so
   * fire-and-forget teardown would leave sockets open past the scope.
   *
   * Service shutdown runs concurrently with interrupting the consumer fiber
   * because an in-flight turn's finalizer can take arbitrarily long. Awaiting
   * the interrupt first would hold the transports open for exactly as long as
   * that finalizer runs.
   * @returns Completion of the channel-owned teardown.
   */
  disconnect(): Effect.Effect<void> {
    return Effect.gen(
      function* (this: MoltZapChannelCore) {
        this.connected = false;
        this.stopped = true;
        // Interrupt the consumer fiber so any queued inbound messages are
        // dropped rather than delivered after the channel is torn down.
        const stopConsumer = Fiber.interrupt(this.consumerFiber);
        const shutdown = this.service.shutdown?.();
        if (shutdown === undefined) {
          this.service.close();
          yield* stopConsumer;
          return;
        }
        yield* Effect.all([stopConsumer, shutdown], {
          concurrency: 2,
          discard: true,
        });
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
        const registered = this.inboundHandler;
        if (registered === null) {
          return;
        }
        if (registered._tag === "raw") {
          if (!(yield* this.interceptTurn(messages))) {
            return;
          }
          yield* this.awaitHandlerTurn(registered.handler, messages, primary);
          return;
        }
        const { enriched, commitContext } =
          yield* MoltZapChannelCore.enrichMessage(this.service, messages);
        if (!(yield* this.interceptTurn(messages))) {
          return;
        }
        const completed = yield* this.awaitHandlerTurn(
          registered.handler,
          enriched,
          primary,
        );
        // Context markers advance only for a turn the handler finished. A
        // dropped or abandoned one leaves its entries for the next turn.
        if (completed && commitContext) {
          commitContext();
        }
      }.bind(this),
    );
  }

  /**
   * Consult the interceptor for this turn, if one is installed.
   * @param messages The coalesced batch, primary first.
   * @returns Whether the handler runs for this batch.
   */
  private interceptTurn(
    messages: readonly Message[],
  ): Effect.Effect<boolean, unknown> {
    const interceptor = this.inboundInterceptor;
    if (interceptor === undefined) {
      return Effect.succeed(true);
    }
    const newest =
      /* Safe because a coalesced batch always holds at least its primary. */ messages[
        messages.length - 1
      ]!;
    // Suspended so an interceptor that throws before returning its Effect
    // becomes a defect this pipeline can fail open on, not one the consumer
    // fiber catches after the turn is already lost.
    return Effect.suspend(() => interceptor(newest)).pipe(
      Effect.flatMap((decision) =>
        this.applyInterceptDecision(newest, decision),
      ),
      Effect.catchAllCause((cause) =>
        // Interruption is teardown, not an interceptor bug: re-raise it so a
        // disconnected channel stops draining instead of delivering the turn.
        Cause.isInterruptedOnly(cause)
          ? Effect.failCause(cause)
          : this.logInterceptorFailure(newest, cause).pipe(Effect.as(true)),
      ),
    );
  }

  /**
   * Apply a verdict, logging the drops at debug so a quiet channel can be
   * traced back to its gate.
   * @param newest Message the interceptor judged.
   * @param decision Verdict for the whole coalesced batch.
   * @returns Whether the handler runs.
   */
  private applyInterceptDecision(
    newest: Message,
    decision: InboundInterceptDecision,
  ): Effect.Effect<boolean> {
    if (decision._tag === "deliver") {
      return Effect.succeed(true);
    }
    return effectLogDebug(
      "MoltZapChannelCore: inbound turn dropped by interceptor",
      {
        messageId: newest.id,
        conversationId: newest.conversationId,
        ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
      },
    ).pipe(Effect.as(false));
  }

  private logInterceptorFailure(
    newest: Message,
    cause: Cause.Cause<unknown>,
  ): Effect.Effect<void> {
    return effectLogWarning(
      "MoltZapChannelCore: inbound interceptor failed, delivering anyway",
      {
        messageId: newest.id,
        conversationId: newest.conversationId,
        causePretty: Cause.pretty(cause),
        ...errorSummary(Cause.squash(cause)),
      },
    );
  }

  /**
   * Await the user handler, bounded by `turnTimeoutMs` when it is set.
   * @param handler Installed inbound handler.
   * @param input Value delivered to the selected handler.
   * @param primary Message that opened this turn.
   * @returns Whether the handler ran to completion.
   */
  private awaitHandlerTurn<A>(
    handler: (input: A) => Effect.Effect<void, unknown>,
    input: A,
    primary: Message,
  ): Effect.Effect<boolean, unknown> {
    // The handler is user code returning an Effect — yield it directly so its
    // typed error channel propagates to the consumer fiber, which logs and
    // continues. Awaiting it inline preserves arrival-order delivery.
    const turn = handler(input);
    const timeoutMs = this.turnTimeoutMs;
    if (timeoutMs === undefined) {
      return turn.pipe(Effect.as(true));
    }
    return turn.pipe(
      Effect.timeoutOption(Duration.millis(timeoutMs)),
      Effect.tap((finished) =>
        Option.isNone(finished)
          ? effectLogWarning(
              "MoltZapChannelCore: inbound turn abandoned after timeout",
              {
                messageId: primary.id,
                conversationId: primary.conversationId,
                timeoutMs,
              },
            )
          : Effect.void,
      ),
      Effect.map(Option.isSome),
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
}
