/**
 * Shared message-enrichment helper for MoltZap channel adapters.
 */

import { Cause, Chunk, Deferred, Duration, Effect, Fiber, Queue } from "effect";
import type { LogicalClock, Message } from "@moltzap/protocol";
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

/**
 * Server → recipient `dispatch/release` notification payload (the
 * verdict). Mirrors `NotificationParamsOf<typeof DispatchRelease>` from
 * the protocol, kept structurally typed here so this module does not
 * need a direct protocol descriptor import (the channel core stays
 * descriptor-free; the wire shape is asserted by the service module).
 */
export interface DispatchReleaseFrame {
  readonly dispatchId: string;
  readonly leaseId: string;
  readonly verdict:
    | {
        readonly decision: "grant";
        readonly leaseId?: string;
        readonly leaseTimeoutMs?: number;
        readonly dispatchMessageId?: string;
      }
    | { readonly decision: "deny"; readonly reason?: string }
    | { readonly decision: "hold"; readonly reason?: string };
  readonly leaseTimeoutMs?: number;
}

/** The subset of MoltZapService that MoltZapChannelCore needs. */
export interface ChannelService {
  readonly ownAgentId: string | undefined;
  on(event: "message", handler: (msg: Message) => void): void;
  on(event: "disconnect", handler: () => void): void;
  on(event: "reconnect", handler: () => void): void;
  on(
    event: "conversationArchived",
    handler: (data: { conversationId: string }) => void,
  ): void;
  on(
    event: "conversationUnarchived",
    handler: (data: { conversationId: string }) => void,
  ): void;
  on(
    event: "dispatchRelease",
    handler: (frame: DispatchReleaseFrame) => void,
  ): void;
  connect(): Effect.Effect<unknown, ServiceRpcError>;
  close(): void;
  send(
    conversationId: string,
    text: string,
    opts?: { dispatchLeaseId?: string },
  ): Effect.Effect<void, ServiceRpcError>;
  isConversationArchived?(conversationId: string): boolean;
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
  /**
   * Issue `dispatch/request` and receive the immediate
   * `{leaseId, dispatchId}` ack. The verdict arrives asynchronously
   * via the `dispatchRelease` event.
   *
   * The argument shape mirrors `ParamsOf<DispatchRequest>` from the
   * protocol (the channel core does not depend on the protocol
   * descriptor, hence the structural shape duplicated here).
   *
   * Optional: when undefined (e.g. unauthenticated test fakes), the
   * channel core falls back to default-grant — every inbound message
   * dispatches without admission.
   */
  requestDispatch?(params: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly senderAgentId: string;
    readonly parts?: ReadonlyArray<unknown>;
    readonly receivedAt?: string;
    readonly pending?: ReadonlyArray<unknown>;
    readonly clock?: LogicalClock;
    readonly attempt?: number;
  }): Effect.Effect<
    { readonly leaseId: string; readonly dispatchId: string },
    ServiceRpcError
  >;
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

const DEFAULT_DISPATCH_ADMISSION_TIMEOUT_MS = 30_000;
const DEFAULT_DISPATCH_LEASE_TIMEOUT_MS = 90_000;
const DISPATCH_RELEASE_RING_CAPACITY = 256;
const DISPATCH_RELEASE_RING_SOFT_TTL_MS = 30_000;

interface PendingReleaseEntry {
  readonly verdict: DispatchReleaseFrame["verdict"];
  readonly leaseTimeoutMs: number | undefined;
  readonly receivedAtMs: number;
}

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
  /**
   * Lease id scoped to the in-flight `dispatchInboundEffect` call
   * (set immediately around the user-handler invocation). Replaces
   * the legacy `activeDispatchLeaseId` field whose semantics were
   * unchanged but whose name leaked an admission-flow detail. The
   * field remains a single mutable cell because the consumer fiber
   * processes inbound work strictly serially (one queue, one fiber);
   * concurrent dispatches do not exist on this code path.
   */
  private leaseIdInFlight: string | undefined;
  /**
   * Per-lease parking Deferreds for dispatches awaiting their
   * `dispatchRelease` verdict. Settled by the `dispatchRelease` event
   * handler when a matching frame arrives.
   */
  private readonly pendingDispatchesByLease = new Map<
    string,
    Deferred.Deferred<DispatchReleaseFrame, never>
  >();
  /**
   * Ring buffer of `dispatchRelease` frames that arrived before the
   * recipient registered its parking Deferred (release-then-ack
   * race). Bounded LRU via Map insertion-order iteration; soft-TTL
   * eviction at `DISPATCH_RELEASE_RING_SOFT_TTL_MS` so a release
   * without a matching ack does not leak memory.
   */
  private readonly pendingReleasesByLease = new Map<
    string,
    PendingReleaseEntry
  >();
  private readonly closedConversationIds = new Set<string>();
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

  constructor(opts: ChannelCoreOptions) {
    this.service = opts.service;
    this.logger = opts.logger ?? noopLogger;
    this.dispatchAdmissionTimeoutMs =
      opts.dispatchAdmissionTimeoutMs ?? DEFAULT_DISPATCH_ADMISSION_TIMEOUT_MS;

    this.service.on("message", (message) => {
      if (this.closedConversationIds.has(message.conversationId)) {
        this.logger.info(
          {
            messageId: message.id,
            conversationId: message.conversationId,
          },
          "MoltZapChannelCore: dropping inbound message for closed conversation",
        );
        return;
      }
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

    this.service.on("conversationArchived", ({ conversationId }) => {
      this.closeConversation(conversationId);
    });

    this.service.on("conversationUnarchived", ({ conversationId }) => {
      this.closedConversationIds.delete(conversationId);
    });

    this.service.on("dispatchRelease", (frame) => {
      this.recordDispatchRelease(frame);
    });
  }

  /**
   * Record an incoming `dispatchRelease` frame. If a matching
   * parking Deferred is registered, settle it inline; otherwise
   * insert into the ring buffer for the future ack-side `consume`.
   * Soft-TTL evicts buffered entries whose age exceeds
   * `DISPATCH_RELEASE_RING_SOFT_TTL_MS`; the hard-cap at
   * `DISPATCH_RELEASE_RING_CAPACITY` evicts the oldest entry once
   * exceeded. Both eviction paths warn-log so operators can spot
   * release-without-ack adversarial patterns.
   */
  private recordDispatchRelease(frame: DispatchReleaseFrame): void {
    const parked = this.pendingDispatchesByLease.get(frame.leaseId);
    if (parked) {
      this.pendingDispatchesByLease.delete(frame.leaseId);
      // `Deferred.unsafeDone` is the sync settler — `succeed` returns an
      // Effect that the caller would have to runFork. The Deferred has
      // `never` in the failure channel, so unsafeDone with Exit.succeed
      // is total.
      Effect.runSync(Deferred.succeed(parked, frame));
      return;
    }
    const nowMs = Date.now();
    this.evictDispatchReleaseRing(nowMs);
    this.pendingReleasesByLease.set(frame.leaseId, {
      verdict: frame.verdict,
      leaseTimeoutMs: frame.leaseTimeoutMs,
      receivedAtMs: nowMs,
    });
    while (this.pendingReleasesByLease.size > DISPATCH_RELEASE_RING_CAPACITY) {
      const oldest = this.pendingReleasesByLease.keys().next().value;
      if (oldest === undefined) break;
      this.pendingReleasesByLease.delete(oldest);
      this.logger.warn(
        { leaseId: oldest },
        "MoltZapChannelCore: dispatchRelease ring buffer evicted oldest entry (capacity reached)",
      );
    }
  }

  private evictDispatchReleaseRing(nowMs: number): void {
    for (const [leaseId, entry] of this.pendingReleasesByLease) {
      if (nowMs - entry.receivedAtMs <= DISPATCH_RELEASE_RING_SOFT_TTL_MS) {
        // Map iteration is insertion-order; once one entry is fresh
        // every subsequent entry is fresher. Stop here.
        return;
      }
      this.pendingReleasesByLease.delete(leaseId);
      this.logger.warn(
        { leaseId, ageMs: nowMs - entry.receivedAtMs },
        "MoltZapChannelCore: dispatchRelease ring buffer evicted stale entry (soft TTL)",
      );
    }
  }

  private consumeDispatchRelease(
    leaseId: string,
  ): PendingReleaseEntry | undefined {
    const entry = this.pendingReleasesByLease.get(leaseId);
    if (entry === undefined) return undefined;
    this.pendingReleasesByLease.delete(leaseId);
    return entry;
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
    if (
      this.closedConversationIds.has(conversationId) ||
      this.service.isConversationArchived?.(conversationId)
    ) {
      return Effect.sync(() =>
        this.logger.info(
          { conversationId },
          "MoltZapChannelCore: dropping reply for closed conversation",
        ),
      );
    }
    return this.service.send(conversationId, text, {
      dispatchLeaseId: opts?.dispatchLeaseId ?? this.leaseIdInFlight,
    });
  }

  private closeConversation(conversationId: string): void {
    this.closedConversationIds.add(conversationId);
    this.parkedByConversation.delete(conversationId);

    const queued = Chunk.toReadonlyArray(
      Effect.runSync(Queue.takeAll(this.inboundQueue)),
    );
    let droppedQueued = 0;
    for (const work of queued) {
      if (work.message.conversationId === conversationId) {
        droppedQueued += 1;
      } else {
        Queue.unsafeOffer(this.inboundQueue, work);
      }
    }

    this.logger.info(
      {
        conversationId,
        droppedQueued,
      },
      "MoltZapChannelCore: closed conversation dispatch work purged",
    );
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

  /**
   * Issue `dispatch/request` against the service, await the lease's
   * `dispatchRelease` verdict, and return the channel-core
   * `DispatchAdmissionDecision`. Absorbs the ack/release race via
   * `pendingDispatchesByLease` (Deferred) plus
   * `pendingReleasesByLease` (LRU ring buffer):
   *   - if release arrives first, the `recordDispatchRelease` event
   *     handler buffers it; this method consumes the buffered entry
   *     after the ack returns.
   *   - if ack arrives first, this method registers a Deferred that
   *     `recordDispatchRelease` settles when the release frame
   *     arrives.
   *
   * When the service has no `requestDispatch` (test fakes that don't
   * exercise admission), default-grant.
   *
   * On request error or release wait timeout, fail-closed with a
   * synthetic deny verdict. The lease (if minted server-side) ages
   * out via the post-grant TTL or LeaseRegistry's
   * abandon-on-disconnect path; nothing here re-issues.
   */
  private dispatchAdmission(
    work: InboundDispatchWork,
  ): Effect.Effect<DispatchAdmissionDecision, ServiceRpcError> {
    if (!this.service.requestDispatch) {
      return Effect.succeed({ _tag: "grant" });
    }
    return Effect.suspend(() =>
      this.service.requestDispatch!({
        conversationId: work.message.conversationId,
        messageId: work.message.id,
        senderAgentId: work.message.senderId,
        parts: work.message.parts,
        attempt: work.attempt,
        receivedAt: new Date(work.receivedAtMs).toISOString(),
        clock: work.clock,
        pending: this.pendingDispatchSnapshot(work),
      }),
    ).pipe(
      // Total deadline for the admission round-trip (ack + release).
      // Hangs in the underlying RPC fall through to the fail-closed
      // branch below; the request itself does not race the ack/release
      // timeouts independently.
      Effect.timeoutFail({
        duration: Duration.millis(this.dispatchAdmissionTimeoutMs),
        onTimeout: () =>
          new Error(
            `dispatch request timed out after ${this.dispatchAdmissionTimeoutMs}ms`,
          ),
      }),
      Effect.flatMap(({ leaseId }) => this.awaitDispatchRelease(work, leaseId)),
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

  /**
   * Wait for the verdict on `leaseId`. Consumes any buffered
   * `dispatchRelease` first; otherwise registers a parking Deferred
   * and bounded-waits for the `recordDispatchRelease` event handler
   * to settle it. The wait timeout matches today's
   * `dispatchAdmissionTimeoutMs` (default 30 s).
   */
  private awaitDispatchRelease(
    work: InboundDispatchWork,
    leaseId: string,
  ): Effect.Effect<DispatchAdmissionDecision, never> {
    return Effect.gen(this, function* () {
      const buffered = this.consumeDispatchRelease(leaseId);
      if (buffered) {
        return this.projectVerdict(work, leaseId, buffered.verdict);
      }
      const deferred = yield* Deferred.make<DispatchReleaseFrame, never>();
      this.pendingDispatchesByLease.set(leaseId, deferred);
      // `ensuring` (not `tap`) guarantees the entry is removed even on
      // interrupt — without it, a fiber interruption (consumer fiber
      // teardown on `disconnect`) would orphan the Deferred + leak the
      // lease entry until process exit.
      const settled = yield* Deferred.await(deferred).pipe(
        Effect.timeoutOption(Duration.millis(this.dispatchAdmissionTimeoutMs)),
        Effect.ensuring(
          Effect.sync(() => {
            this.pendingDispatchesByLease.delete(leaseId);
          }),
        ),
      );
      if (settled._tag === "None") {
        this.logger.warn(
          {
            messageId: work.message.id,
            conversationId: work.message.conversationId,
            leaseId,
            timeoutMs: this.dispatchAdmissionTimeoutMs,
          },
          "MoltZapChannelCore: dispatchRelease wait timed out — fail-closed deny",
        );
        return {
          _tag: "deny" as const,
          reason: "dispatch release wait timed out",
        };
      }
      return this.projectVerdict(work, leaseId, settled.value.verdict);
    });
  }

  private projectVerdict(
    work: InboundDispatchWork,
    leaseId: string,
    verdict: DispatchReleaseFrame["verdict"],
  ): DispatchAdmissionDecision {
    if (verdict.decision === "grant") {
      this.logger.info(
        {
          messageId: work.message.id,
          conversationId: work.message.conversationId,
          attempt: work.attempt,
          leaseId,
          leaseTimeoutMs: verdict.leaseTimeoutMs,
          dispatchMessageId: verdict.dispatchMessageId,
        },
        "MoltZapChannelCore: dispatch admission granted",
      );
      const grant: DispatchAdmissionDecision = {
        _tag: "grant",
        leaseId: verdict.leaseId ?? leaseId,
        ...(verdict.leaseTimeoutMs !== undefined
          ? { leaseTimeoutMs: verdict.leaseTimeoutMs }
          : {}),
        ...(verdict.dispatchMessageId
          ? { dispatchMessageId: verdict.dispatchMessageId }
          : {}),
      };
      return grant;
    }
    if (verdict.decision === "deny") {
      return {
        _tag: "deny",
        ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
      };
    }
    return {
      _tag: "hold",
      ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
    };
  }

  private dispatchInboundWork(
    work: InboundDispatchWork,
  ): Effect.Effect<void, unknown> {
    return Effect.gen(this, function* () {
      const current = this.takeDispatchCandidate(work);
      if (this.closedConversationIds.has(current.message.conversationId)) {
        yield* Effect.sync(() =>
          this.logger.info(
            {
              messageId: current.message.id,
              conversationId: current.message.conversationId,
              attempt: current.attempt,
            },
            "MoltZapChannelCore: dropping dispatch for closed conversation",
          ),
        );
        return;
      }
      const decision = yield* this.dispatchAdmission(current);
      if (decision._tag === "grant") {
        const messages = this.service.requestDispatch
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
        const dispatch = Effect.sync(() => {
          const previous = this.leaseIdInFlight;
          this.leaseIdInFlight = decision.leaseId;
          return previous;
        }).pipe(
          Effect.flatMap((previous) =>
            this.dispatchInboundEffect(messages).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  this.leaseIdInFlight = previous;
                }),
              ),
            ),
          ),
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
        this.leaseIdInFlight !== undefined
          ? { ...enriched, dispatchLeaseId: this.leaseIdInFlight }
          : enriched;
      // The handler is user code returning an Effect — yield it directly so
      // its typed error channel propagates to the consumer fiber, which logs
      // and continues. We await it inline to preserve arrival-order delivery.
      yield* this.inboundHandler(leased);
      if (commitContext) commitContext();
    });
  }
}
