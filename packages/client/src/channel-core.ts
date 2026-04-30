/**
 * Shared message-enrichment helper for MoltZap channel adapters.
 */

import { Cause, Chunk, Duration, Effect, Fiber, Queue } from "effect";
import type {
  LogicalClock,
  Message,
  PermissionsRequiredEvent,
} from "@moltzap/protocol";
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
  /** Lease that authorizes a runtime reply for this dispatch, when present. */
  dispatchLeaseId?: string;
}

export interface PendingDispatchMessage {
  messageId: string;
  conversationId: string;
  senderAgentId: string;
  createdAt: string;
  receivedAt: string;
  clock?: LogicalClock;
  parts?: Message["parts"];
}

export interface DispatchAdmissionRequest {
  message: Message;
  conversationId: string;
  senderAgentId: string;
  attempt: number;
  receivedAt: string;
  clock: LogicalClock;
  pending: ReadonlyArray<PendingDispatchMessage>;
}

export type DispatchAdmissionDecision =
  | {
      _tag: "grant";
      leaseId?: string;
      leaseTimeoutMs?: number;
      dispatchMessageId?: string;
    }
  | { _tag: "deny"; reason?: string }
  | { _tag: "hold"; reason?: string };

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

const DEFAULT_DISPATCH_ADMISSION_TIMEOUT_MS = 900_000;
const DEFAULT_DISPATCH_LEASE_TIMEOUT_MS = 90_000;

class DispatchLeaseExpired extends Error {
  constructor(
    readonly messageId: string,
    readonly conversationId: string,
    readonly timeoutMs: number,
  ) {
    super(`dispatch lease expired after ${timeoutMs}ms`);
    this.name = "DispatchLeaseExpired";
  }
}

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
  clock: LogicalClock;
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
  private readonly logicalClocks = new Map<
    string,
    { epoch: number; vector: Record<string, number> }
  >();
  private readonly parkedByConversation = new Map<
    string,
    InboundDispatchWork[]
  >();
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
        clock: this.observeMessage(message),
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
    opts?: { dispatchLeaseId?: string },
  ): Effect.Effect<void, ServiceRpcError> {
    return this.service.send(conversationId, text, {
      dispatchLeaseId: opts?.dispatchLeaseId ?? this.activeDispatchLeaseId,
    });
  }

  private observeMessage(message: Message): LogicalClock {
    const current = this.logicalClocks.get(message.conversationId) ?? {
      epoch: 0,
      vector: {},
    };
    const vector = {
      ...current.vector,
      [message.senderId]: (current.vector[message.senderId] ?? 0) + 1,
    };
    const next = { epoch: current.epoch + 1, vector };
    this.logicalClocks.set(message.conversationId, next);
    return {
      domainId: message.conversationId,
      epoch: next.epoch,
      vector,
    };
  }

  private takeDispatchCandidate(
    incoming: InboundDispatchWork,
  ): InboundDispatchWork {
    const conversationId = incoming.message.conversationId;
    const parked = this.parkedByConversation.get(conversationId);
    if (!parked || parked.length === 0) return incoming;

    parked.push(incoming);
    const next = parked.shift()!;
    if (parked.length === 0) {
      this.parkedByConversation.delete(conversationId);
    } else {
      this.parkedByConversation.set(conversationId, parked);
    }
    return next;
  }

  private parkDispatchWork(work: InboundDispatchWork): void {
    const conversationId = work.message.conversationId;
    const parked = this.parkedByConversation.get(conversationId) ?? [];
    parked.unshift({
      ...work,
      attempt: work.attempt + 1,
    });
    this.parkedByConversation.set(conversationId, parked);
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
        clock: work.clock,
        pending: this.pendingDispatchSnapshot(work),
      }),
    ).pipe(
      Effect.tap((decision) =>
        Effect.sync(() => {
          if (decision._tag === "grant") {
            this.logger.info(
              {
                messageId: work.message.id,
                conversationId: work.message.conversationId,
                attempt: work.attempt,
                leaseId: decision.leaseId,
                leaseTimeoutMs: decision.leaseTimeoutMs,
                dispatchMessageId: decision.dispatchMessageId,
              },
              "MoltZapChannelCore: dispatch admission granted",
            );
          }
        }),
      ),
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
            "MoltZapChannelCore: dispatch admission failed closed",
          );
          return {
            _tag: "deny" as const,
            reason: "dispatch admission unavailable",
          };
        }),
      ),
    );
  }

  private dispatchInboundWork(
    work: InboundDispatchWork,
  ): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      const current = this.takeDispatchCandidate(work);
      const decision = yield* this.dispatchAdmission(current);
      if (decision._tag === "grant") {
        const messages = this.service.authorizeDispatch
          ? yield* this.takeCoalescedConversationMessages(
              current,
              decision.dispatchMessageId,
            )
          : [current.message];
        if (messages.length === 0) {
          yield* Effect.sync(() =>
            this.logger.warn(
              {
                messageId: current.message.id,
                conversationId: current.message.conversationId,
                attempt: current.attempt,
                dispatchMessageId: decision.dispatchMessageId,
              },
              "MoltZapChannelCore: dispatch admission target unavailable",
            ),
          );
          return;
        }
        const primaryMessage = messages[0]!;
        yield* Effect.sync(() =>
          this.logger.info(
            {
              messageId: primaryMessage.id,
              admittedMessageId: current.message.id,
              conversationId: current.message.conversationId,
              attempt: current.attempt,
              leaseId: decision.leaseId,
              coalescedMessageCount: messages.length,
            },
            "MoltZapChannelCore: inbound dispatch starting",
          ),
        );
        const dispatch = Effect.acquireUseRelease(
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
        const timeoutMs = decision.leaseId
          ? (decision.leaseTimeoutMs ?? DEFAULT_DISPATCH_LEASE_TIMEOUT_MS)
          : undefined;
        let dispatchTimedOut = false;
        if (timeoutMs === undefined) {
          yield* dispatch;
        } else {
          yield* dispatch.pipe(
            Effect.timeoutFail({
              duration: Duration.millis(timeoutMs),
              onTimeout: () =>
                new DispatchLeaseExpired(
                  primaryMessage.id,
                  primaryMessage.conversationId,
                  timeoutMs,
                ),
            }),
            Effect.catchAll((err) => {
              if (err instanceof DispatchLeaseExpired) {
                return Effect.sync(() => {
                  dispatchTimedOut = true;
                  this.logger.warn(
                    {
                      messageId: err.messageId,
                      conversationId: err.conversationId,
                      attempt: current.attempt,
                      leaseId: decision.leaseId,
                      timeoutMs: err.timeoutMs,
                    },
                    "MoltZapChannelCore: inbound dispatch lease expired",
                  );
                });
              }
              return Effect.fail(err);
            }),
          );
        }
        if (!dispatchTimedOut) {
          yield* Effect.sync(() =>
            this.logger.info(
              {
                messageId: primaryMessage.id,
                admittedMessageId: current.message.id,
                conversationId: current.message.conversationId,
                attempt: current.attempt,
                leaseId: decision.leaseId,
              },
              "MoltZapChannelCore: inbound dispatch completed",
            ),
          );
        }
        return;
      }

      if (decision._tag === "deny") {
        yield* Effect.sync(() =>
          this.logger.info(
            {
              messageId: current.message.id,
              conversationId: current.message.conversationId,
              attempt: current.attempt,
              reason: decision.reason,
            },
            "MoltZapChannelCore: inbound dispatch denied",
          ),
        );
        return;
      }

      yield* Effect.sync(() =>
        this.logger.info(
          {
            messageId: current.message.id,
            conversationId: current.message.conversationId,
            attempt: current.attempt,
            reason: decision.reason,
          },
          "MoltZapChannelCore: inbound dispatch held",
        ),
      );
      this.parkDispatchWork(current);
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
    const parked = [...this.parkedByConversation.values()].flat();
    return [active, ...parked, ...queued].map((work) => ({
      messageId: work.message.id,
      conversationId: work.message.conversationId,
      senderAgentId: work.message.senderId,
      createdAt: work.message.createdAt,
      receivedAt: new Date(work.receivedAtMs).toISOString(),
      clock: work.clock,
      parts: work.message.parts,
    }));
  }

  private takeCoalescedConversationMessages(
    work: InboundDispatchWork,
    dispatchMessageId?: string,
  ): Effect.Effect<ReadonlyArray<Message>, never> {
    return Effect.sync(() => {
      const queued = Chunk.toReadonlyArray(
        Effect.runSync(Queue.takeAll(this.inboundQueue)),
      );
      const parked = this.parkedByConversation.get(work.message.conversationId);
      const sameConversation: Message[] = [work.message];
      const remaining: InboundDispatchWork[] = [];
      if (parked) {
        sameConversation.push(
          ...parked.map((parkedWork) => parkedWork.message),
        );
        this.parkedByConversation.delete(work.message.conversationId);
      }
      for (const queuedWork of queued) {
        if (queuedWork.message.conversationId === work.message.conversationId) {
          sameConversation.push(queuedWork.message);
        } else {
          remaining.push(queuedWork);
        }
      }
      const startIndex =
        dispatchMessageId === undefined
          ? 0
          : sameConversation.findIndex(
              (message) => message.id === dispatchMessageId,
            );
      for (const remainingWork of remaining) {
        Queue.unsafeOffer(this.inboundQueue, remainingWork);
      }
      if (startIndex < 0) return [];
      return sameConversation.slice(startIndex);
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
      const leased =
        this.activeDispatchLeaseId !== undefined
          ? { ...enriched, dispatchLeaseId: this.activeDispatchLeaseId }
          : enriched;
      // The handler is user code returning an Effect — yield it directly so
      // its typed error channel propagates to the consumer fiber, which logs
      // and continues. We await it inline to preserve arrival-order delivery.
      yield* this.inboundHandler(leased);
      if (commitContext) commitContext();
    });
  }
}
