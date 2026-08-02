/**
 * Shared message-enrichment helper for MoltZap channel adapters.
 */

import {
  Cause,
  Chunk,
  Data,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Match,
  Option,
  Queue,
} from "effect";
import type { ConversationId } from "@moltzap/protocol/conversation";
import { BoundedMap } from "./bounded-map.js";
import {
  DEFAULT_DISPATCH_LEASE_TIMEOUT_MS,
  type LeaseId,
} from "@moltzap/protocol/message/dispatch";
import type { Message } from "@moltzap/protocol/message";
import type {
  CrossConversationEntry,
  CrossConvMessage,
  ServiceRpcError,
} from "./service.js";
import { enrichChannelMessage } from "./channel-core-enrichment.js";

class DispatchAdmissionTimedOut extends Data.TaggedError(
  "DispatchAdmissionTimedOut",
)<{
  readonly timeoutMs: number;
}> {
  override get message(): string {
    return `dispatch request timed out after ${this.timeoutMs}ms`;
  }
}

class DispatchLeaseExpired extends Data.TaggedError("DispatchLeaseExpired")<{
  readonly messageId: string;
  readonly conversationId: string;
  readonly timeoutMs: number;
}> {
  override get message(): string {
    return `dispatch lease expired after ${this.timeoutMs}ms`;
  }
}

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
   * coalesced into this single dispatch. Includes the primary message first.
   */
  coalescedMessages?: ReadonlyArray<{
    id: string;
    sender: EnrichedSender;
    text: string;
    createdAt: string;
  }>;
  /** Lease that authorizes a runtime reply for this dispatch, when present. */
  dispatchLeaseId?: LeaseId;
}

/** Describes pending dispatch message. */
export interface PendingDispatchMessage {
  messageId: string;
  conversationId: string;
  senderAgentId: string;
  createdAt: string;
  receivedAt: string;
  parts?: Message["parts"];
}

/** Describes dispatch admission request. */
export interface DispatchAdmissionRequest {
  message: Message;
  conversationId: string;
  senderAgentId: string;
  attempt: number;
  receivedAt: string;
  pending: readonly PendingDispatchMessage[];
}

/** Represents dispatch admission decision values. */
export type DispatchAdmissionDecision =
  | {
      _tag: "grant";
      leaseId?: LeaseId;
      leaseTimeoutMs?: number;
      dispatchMessageId?: string;
    }
  | { _tag: "deny"; reason?: string }
  | { _tag: "hold"; reason?: string };

type DispatchGrantDecision = Extract<
  DispatchAdmissionDecision,
  { readonly _tag: "grant" }
>;
type DispatchDenyDecision = Extract<
  DispatchAdmissionDecision,
  { readonly _tag: "deny" }
>;
type DispatchHoldDecision = Extract<
  DispatchAdmissionDecision,
  { readonly _tag: "hold" }
>;

/**
 * Server → recipient `agent/dispatch/released` notification payload (the
 * verdict). Mirrors `NotificationParamsOf&lt;typeof DispatchRelease>` from
 * the protocol, kept structurally typed here so this module does not
 * need a direct protocol descriptor import (the channel core stays
 * descriptor-free; the wire shape is asserted by the service module).
 */
export interface DispatchReleaseFrame {
  readonly dispatchId: string;
  readonly leaseId: LeaseId;
  readonly verdict:
    | {
        readonly decision: "grant";
        readonly leaseId?: LeaseId;
        readonly leaseTimeoutMs?: number;
        readonly dispatchMessageId?: string;
      }
    | { readonly decision: "deny"; readonly reason?: string }
    | { readonly decision: "hold"; readonly reason?: string };
  readonly leaseTimeoutMs?: number;
}

/** The subset of MoltZapService that MoltZapChannelCore needs. */
export interface ChannelService {
  readonly ownAgentId?: string;
  on(event: "message", handler: (payload: { message: Message }) => void): void;
  on(event: "disconnect", handler: () => void): void;
  on(
    event: "dispatchRelease",
    handler: (frame: DispatchReleaseFrame) => void,
  ): void;
  connect(): Effect.Effect<unknown, ServiceRpcError>;
  /** Effectful teardown used by scoped process owners. */
  shutdown?(): Effect.Effect<void>;
  close(): void;
  send(
    conversationId: ConversationId,
    text: string,
    opts?: { dispatchLeaseId?: LeaseId },
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

  /**
   * Issue `agent/dispatch/request` and receive either the immediate
   * `{leaseId, dispatchId}` ack or `conversation_busy`. The verdict for a
   * minted lease arrives asynchronously via the `dispatchRelease` event.
   *
   * The argument shape mirrors `ParamsOf&lt;DispatchRequest>` from the
   * protocol (the channel core does not depend on the protocol
   * descriptor, hence the structural shape duplicated here).
   *
   * Optional: when undefined (e.g. Unauthenticated test fakes), the
   * channel core falls back to default-grant — every inbound message
   * dispatches without admission.
   */
  requestDispatch?(params: {
    readonly conversationId: string;
    readonly messageId: string;
    readonly senderAgentId: string;
    readonly parts?: readonly unknown[];
    readonly receivedAt?: string;
    readonly pending?: readonly unknown[];
    readonly attempt?: number;
  }): Effect.Effect<
    | { readonly leaseId: LeaseId; readonly dispatchId: string }
    | { readonly outcome: "conversation_busy" },
    ServiceRpcError
  >;
}

/** Configures channel core. */
export interface ChannelCoreOptions {
  service: ChannelService;
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

interface InboundHandlerRegistration {
  readonly handler: InboundHandler;
}

const DEFAULT_DISPATCH_ADMISSION_TIMEOUT_MS = 30_000;
const DISPATCH_RELEASE_RING_CAPACITY = 256;
const DISPATCH_RELEASE_RING_SOFT_TTL_MS = 30_000;

interface PendingReleaseEntry {
  readonly verdict: DispatchReleaseFrame["verdict"];
  readonly leaseTimeoutMs?: number;
  readonly receivedAtMs: number;
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

function effectLogInfo(
  message: string,
  annotations: Record<string, unknown>,
): Effect.Effect<void> {
  return Effect.logInfo(message).pipe(Effect.annotateLogs(annotations));
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

interface InboundDispatchWork {
  message: Message;
  attempt: number;
  receivedAtMs: number;
}

/**
 * Wraps a `MoltZapService` with message enrichment, dispatch-chain ordering,
 * and a send helper. One core per service — `getContextEntries()` is
 * side-effectful (advances per-conversation markers), so a second core
 * would consume entries the first expected.
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
 *   Note over core: dedup via recordMessageIdIfNew; Queue.unsafeOffer(inboundQueue, work)
 *   Note over core: messages observed without an inbound handler are transiently dropped; consumer fiber uses Queue.take and takeDispatchCandidate prefers parked[convId]
 *   core->>server: agent/dispatch/request — dispatchAdmission
 *   server-->>core: ack {leaseId, dispatchId}
 *   Note over server,core: ack/release race absorbed via pendingDispatchesByLease (Deferred) and pendingReleasesByLease (ring 256, soft-TTL 30s)
 *   server->>ws: agent/dispatch/released notification
 *   ws->>core: recordDispatchRelease — settles Deferred or buffers
 *   alt verdict deny
 *     Note over core: log + drop
 *   else verdict hold
 *     Note over core: parkDispatchWork — front of parked[convId]
 *   else verdict grant
 *     Note over core: takeCoalescedConversationMessages; drains same-conv from queue + parked
 *     Note over core: dispatchWithLease; lease scoped to ConversationId; enrichMessage — sender name, conversation, context entries
 *     core->>handler: inboundHandler(enriched)
 *     handler-->>core: Effect.void
 *     Note over core: handler exceeds leaseTimeoutMs (90s) → DispatchLeaseExpired
 *   end
 * ```
 *
 * Parking semantics: `hold` re-enters at `parked[convId]` FRONT.
 * `takeDispatchCandidate` prefers the parked queue for the next pull
 * so backpressure within one conversation does not starve others.
 */
export class MoltZapChannelCore {
  private readonly service: ChannelService;
  private readonly dispatchAdmissionTimeoutMs: number;
  private connected = false;
  private inboundHandlerRegistration: InboundHandlerRegistration | null = null;

  /**
   * Dispatch authority is keyed by conversation so work performed through
   * the core for another conversation cannot inherit the active handler's
   * lease. The single consumer prevents overlapping writes for the same
   * conversation while set/restore cleanup is active.
   */
  private readonly leaseIdsInFlightByConversation = new Map<
    ConversationId,
    LeaseId
  >();

  /**
   * Per-lease parking Deferreds for dispatches awaiting their
   * `dispatchRelease` verdict. Settled by the `dispatchRelease` event
   * handler when a matching frame arrives.
   */
  private readonly pendingDispatchesByLease = new Map<
    string,
    Deferred.Deferred<DispatchReleaseFrame>
  >();

  /**
   * Ring buffer of `dispatchRelease` frames that arrived before the
   * recipient registered its parking Deferred (release-then-ack
   * race). `BoundedMap` refreshes insertion order when a lease is set
   * again and evicts the oldest entry at capacity. Soft-TTL eviction at
   * `DISPATCH_RELEASE_RING_SOFT_TTL_MS` keeps a release without a matching
   * ack from retaining memory.
   */
  private readonly pendingReleasesByLease = new BoundedMap<
    string,
    PendingReleaseEntry
  >(DISPATCH_RELEASE_RING_CAPACITY);
  private readonly parkedByConversation = new Map<
    string,
    InboundDispatchWork[]
  >();

  /**
   * Inbound messages with an installed handler enqueue synchronously; a single
   * forked consumer fiber serialises delivery in arrival order.
   */
  private readonly inboundQueue: Queue.Queue<InboundDispatchWork> =
    Effect.runSync(Queue.unbounded<InboundDispatchWork>());
  private readonly consumerFiber: Fiber.RuntimeFiber<void>;
  private readonly disconnectHandlers: Array<() => void> = [];

  constructor(opts: ChannelCoreOptions) {
    this.service = opts.service;
    this.dispatchAdmissionTimeoutMs =
      opts.dispatchAdmissionTimeoutMs ?? DEFAULT_DISPATCH_ADMISSION_TIMEOUT_MS;

    this.registerMessageListener();
    this.consumerFiber = this.startConsumerFiber();
    this.registerConnectionListeners();
    this.registerDispatchReleaseListener();
  }

  private registerMessageListener(): void {
    this.service.on("message", ({ message }) => {
      if (this.inboundHandlerRegistration === null) {
        return;
      }
      Queue.unsafeOffer(this.inboundQueue, {
        message,
        attempt: 0,
        receivedAtMs: Date.now(),
      });
    });
  }

  private startConsumerFiber(): Fiber.RuntimeFiber<void> {
    const consumer = Effect.forever(
      Queue.take(this.inboundQueue).pipe(
        Effect.flatMap((work) =>
          this.dispatchInboundWork(work).pipe(
            Effect.catchAllCause((cause) =>
              this.logInboundFailure(work, cause),
            ),
          ),
        ),
      ),
    );
    return Effect.runFork(consumer);
  }

  private logInboundFailure(
    work: InboundDispatchWork,
    cause: Cause.Cause<unknown>,
  ): Effect.Effect<void> {
    return effectLogError("MoltZapChannelCore: inbound handler failed", {
      messageId: work.message.id,
      conversationId: work.message.conversationId,
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

  private registerDispatchReleaseListener(): void {
    this.service.on("dispatchRelease", (frame) => {
      this.recordDispatchRelease(frame);
    });
  }

  /**
   * Record an incoming `dispatchRelease` frame. If a matching
   * parking Deferred is registered, settle it inline; otherwise
   * insert into the ring buffer for the future ack-side `consume`.
   * Soft-TTL evicts buffered entries whose age exceeds
   * `DISPATCH_RELEASE_RING_SOFT_TTL_MS`; insertion at the hard cap
   * evicts the oldest entry. Both eviction paths warn-log so operators
   * can spot release-without-ack adversarial patterns.
   * @param frame Value supplied to the operation.
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
    const evicted = this.pendingReleasesByLease.set(frame.leaseId, {
      verdict: frame.verdict,
      leaseTimeoutMs: frame.leaseTimeoutMs,
      receivedAtMs: nowMs,
    });
    if (evicted !== undefined) {
      const [evictedLeaseId] = evicted;
      runBackgroundLog(
        effectLogWarning(
          "MoltZapChannelCore: dispatchRelease ring buffer evicted oldest entry (capacity reached)",
          { leaseId: evictedLeaseId },
        ),
      );
    }
  }

  private evictDispatchReleaseRing(nowMs: number): void {
    for (const [leaseId, entry] of this.pendingReleasesByLease) {
      if (nowMs - entry.receivedAtMs <= DISPATCH_RELEASE_RING_SOFT_TTL_MS) {
        // BoundedMap iterates oldest-set first, so every subsequent entry is
        // fresher once this one remains inside the TTL.
        return;
      }
      this.pendingReleasesByLease.delete(leaseId);
      runBackgroundLog(
        effectLogWarning(
          "MoltZapChannelCore: dispatchRelease ring buffer evicted stale entry (soft TTL)",
          { leaseId, ageMs: nowMs - entry.receivedAtMs },
        ),
      );
    }
  }

  private consumeDispatchRelease(
    leaseId: LeaseId,
  ): PendingReleaseEntry | undefined {
    const entry = this.pendingReleasesByLease.get(leaseId);
    if (entry === undefined) {
      return undefined;
    }
    this.pendingReleasesByLease.delete(leaseId);
    return entry;
  }

  /**
   * Replaces any previous handler.
   * @param handler Handler invoked for matching requests.
   * @returns An idempotent disposer for this registration generation.
   */
  onInbound<E>(handler: InboundHandler<E>): () => void {
    const registration: InboundHandlerRegistration = { handler };
    this.inboundHandlerRegistration = registration;
    return () => {
      if (this.inboundHandlerRegistration === registration) {
        this.inboundHandlerRegistration = null;
      }
    };
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
        this.connected = false;
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
   * Reply into a conversation with an explicit dispatch lease when supplied,
   * otherwise with only the active lease for `conversationId`.
   * @param conversationId Value supplied to the operation.
   * @param text Text to process.
   * @param opts Value supplied to the operation.
   * @param opts.dispatchLeaseId Value supplied to the operation.
   * @returns The send result.
   */
  sendReply(
    conversationId: ConversationId,
    text: string,
    opts?: { dispatchLeaseId?: LeaseId },
  ): Effect.Effect<void, ServiceRpcError> {
    return this.service.send(conversationId, text, {
      dispatchLeaseId:
        opts?.dispatchLeaseId ??
        this.leaseIdsInFlightByConversation.get(conversationId),
    });
  }

  private takeDispatchCandidate(
    incoming: InboundDispatchWork,
  ): InboundDispatchWork {
    const conversationId = incoming.message.conversationId;
    const parked = this.parkedByConversation.get(conversationId);
    if (!parked || parked.length === 0) {
      return incoming;
    }

    parked.push(incoming);
    const next =
      /* Safe because the surrounding invariant establishes this asserted shape. */ parked.shift()!;
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
   * Issue `agent/dispatch/request` against the service, await the lease's
   * `dispatchRelease` verdict, and return the channel-core
   * `DispatchAdmissionDecision`. Absorbs the ack/release race via
   * `pendingDispatchesByLease` (Deferred) plus
   * `pendingReleasesByLease` (refresh-on-set FIFO ring buffer):
   *   - if release arrives first, the `recordDispatchRelease` event
   *     handler buffers it; this method consumes the buffered entry
   *     after the ack returns.
   *   - if ack arrives first, this method registers a Deferred that
   *     `recordDispatchRelease` settles when the release frame
   *     arrives.
   *
   * Per-message lease state machine:.
   *
   * ```mermaid
   * stateDiagram-v2
   *   [*] --> PENDING
   *   PENDING : agent/dispatch/request sent; server minting lease
   *   PENDING --> AWAITING_RELEASE : ack returns leaseId
   *   AWAITING_RELEASE : Deferred registered; or buffered release consumed
   *   AWAITING_RELEASE --> GRANTED : verdict grant
   *   AWAITING_RELEASE --> DENIED : verdict deny
   *   AWAITING_RELEASE --> HELD : verdict hold
   *   HELD : parkDispatchWork — re-queued at parked[convId] front
   *   GRANTED : proceed to enrichment
   *   DENIED : drop message — consumer fiber continues
   *   GRANTED --> IN_FLIGHT : dispatchWithLease
   *   IN_FLIGHT : lease keyed by ConversationId; handler executing; lease authorizes one agent/message/send
   *   IN_FLIGHT --> CONSUMED : handler returns within leaseTimeoutMs; server marks via dispatchLeaseId
   *   IN_FLIGHT --> EXPIRED : handler exceeds leaseTimeoutMs; DispatchLeaseExpired logged
   *   CONSUMED --> [*]
   *   DENIED --> [*]
   *   EXPIRED --> [*]
   * ```
   *
   * `HELD` stays at the parked-front. Later inbound work for that same
   * conversation wakes its next dispatch attempt without preventing inbound
   * work for other conversations from progressing.
   *
   * When the service has no `requestDispatch` (test fakes that don't
   * exercise admission), default-grant.
   *
   * On request error or release wait timeout, fail-closed with a
   * synthetic deny verdict. The lease (if minted server-side) ages
   * out via the post-grant TTL or LeaseRegistry's
   * abandon-on-disconnect path; nothing here re-issues.
   * @param work Value supplied to the operation.
   * @returns The dispatch admission result.
   */
  private dispatchAdmission(
    work: InboundDispatchWork,
  ): Effect.Effect<DispatchAdmissionDecision, ServiceRpcError> {
    if (!this.service.requestDispatch) {
      return Effect.succeed({ _tag: "grant" });
    }
    return Effect.suspend(() =>
      /* Safe because the surrounding invariant establishes this asserted shape. */ this
        .service.requestDispatch!({
        conversationId: work.message.conversationId,
        messageId: work.message.id,
        senderAgentId: work.message.senderId,
        parts: work.message.parts,
        attempt: work.attempt,
        receivedAt: new Date(work.receivedAtMs).toISOString(),
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
          new DispatchAdmissionTimedOut({
            timeoutMs: this.dispatchAdmissionTimeoutMs,
          }),
      }),
      Effect.flatMap((result) =>
        "outcome" in result
          ? Effect.succeed(MoltZapChannelCore.holdDecision(result.outcome))
          : this.awaitDispatchRelease(work, result.leaseId),
      ),
      Effect.catchAll((err) =>
        Effect.gen(function* () {
          yield* effectLogWarning(
            "MoltZapChannelCore: dispatch admission failed closed",
            {
              messageId: work.message.id,
              conversationId: work.message.conversationId,
              attempt: work.attempt,
              err,
            },
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
   * @param work Value supplied to the operation.
   * @param leaseId Value supplied to the operation.
   * @returns The buffered result.
   */
  private awaitDispatchRelease(
    work: InboundDispatchWork,
    leaseId: LeaseId,
  ): Effect.Effect<DispatchAdmissionDecision> {
    return Effect.gen(
      function* (this: MoltZapChannelCore) {
        const buffered = this.consumeDispatchRelease(leaseId);
        if (buffered) {
          return this.projectVerdict(work, leaseId, buffered.verdict);
        }
        const deferred = yield* Deferred.make<DispatchReleaseFrame>();
        this.pendingDispatchesByLease.set(leaseId, deferred);
        // `ensuring` (not `tap`) guarantees the entry is removed even on
        // interrupt — without it, a fiber interruption (consumer fiber
        // teardown on `disconnect`) would orphan the Deferred + leak the
        // lease entry until process exit.
        const settled = yield* Deferred.await(deferred).pipe(
          Effect.timeoutOption(
            Duration.millis(this.dispatchAdmissionTimeoutMs),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              this.pendingDispatchesByLease.delete(leaseId);
            }),
          ),
        );
        if (Option.isNone(settled)) {
          yield* effectLogWarning(
            "MoltZapChannelCore: dispatchRelease wait timed out - fail-closed deny",
            {
              messageId: work.message.id,
              conversationId: work.message.conversationId,
              leaseId,
              timeoutMs: this.dispatchAdmissionTimeoutMs,
            },
          );
          return {
            _tag: "deny" as const,
            reason: "dispatch release wait timed out",
          };
        }
        return this.projectVerdict(work, leaseId, settled.value.verdict);
      }.bind(this),
    );
  }

  private projectVerdict(
    work: InboundDispatchWork,
    leaseId: LeaseId,
    verdict: DispatchReleaseFrame["verdict"],
  ): DispatchAdmissionDecision {
    if (verdict.decision === "grant") {
      return this.projectGrantVerdict(work, leaseId, verdict);
    }
    if (verdict.decision === "deny") {
      return MoltZapChannelCore.denyDecision(verdict.reason);
    }
    return MoltZapChannelCore.holdDecision(verdict.reason);
  }

  private projectGrantVerdict(
    work: InboundDispatchWork,
    leaseId: LeaseId,
    verdict: Extract<
      DispatchReleaseFrame["verdict"],
      { readonly decision: "grant" }
    >,
  ): DispatchGrantDecision {
    runBackgroundLog(
      effectLogInfo("MoltZapChannelCore: dispatch admission granted", {
        messageId: work.message.id,
        conversationId: work.message.conversationId,
        attempt: work.attempt,
        leaseId,
        leaseTimeoutMs: verdict.leaseTimeoutMs,
        dispatchMessageId: verdict.dispatchMessageId,
      }),
    );
    return {
      _tag: "grant",
      leaseId: verdict.leaseId ?? leaseId,
      ...(verdict.leaseTimeoutMs !== undefined
        ? { leaseTimeoutMs: verdict.leaseTimeoutMs }
        : {}),
      ...(verdict.dispatchMessageId
        ? { dispatchMessageId: verdict.dispatchMessageId }
        : {}),
    };
  }

  private static denyDecision(reason?: string): DispatchDenyDecision {
    return {
      _tag: "deny",
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  private static holdDecision(reason?: string): DispatchHoldDecision {
    return {
      _tag: "hold",
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  private dispatchInboundWork(
    work: InboundDispatchWork,
  ): Effect.Effect<void, unknown> {
    return Effect.gen(
      function* (this: MoltZapChannelCore) {
        const current = this.takeDispatchCandidate(work);
        const decision = yield* this.dispatchAdmission(current);
        yield* this.handleDispatchDecision(current, decision);
      }.bind(this),
    );
  }

  private handleDispatchDecision(
    current: InboundDispatchWork,
    decision: DispatchAdmissionDecision,
  ): Effect.Effect<void, unknown> {
    return Match.value(decision).pipe(
      Match.tag("grant", (grant) => this.dispatchGrantedWork(current, grant)),
      Match.tag("deny", (deny) => this.logDeniedDispatch(current, deny)),
      Match.tag("hold", (hold) => this.holdDispatchWork(current, hold)),
      Match.exhaustive,
    );
  }

  private dispatchGrantedWork(
    current: InboundDispatchWork,
    decision: DispatchGrantDecision,
  ): Effect.Effect<void, unknown> {
    return Effect.gen(
      function* (this: MoltZapChannelCore) {
        const messages = yield* this.messagesForGrantedDispatch(
          current,
          decision,
        );
        if (messages.length === 0) {
          yield* this.logDispatchTargetUnavailable(current, decision);
          return;
        }
        const primaryMessage =
          /* Safe because the surrounding invariant establishes this asserted shape. */ messages[0]!;
        yield* this.logDispatchStart(
          current,
          primaryMessage,
          messages,
          decision,
        );
        const timedOut = yield* this.runGrantedDispatch(
          current,
          primaryMessage,
          messages,
          decision,
        );
        if (!timedOut) {
          yield* this.logDispatchCompleted(current, primaryMessage, decision);
        }
      }.bind(this),
    );
  }

  private messagesForGrantedDispatch(
    current: InboundDispatchWork,
    decision: DispatchGrantDecision,
  ): Effect.Effect<readonly Message[]> {
    return this.service.requestDispatch
      ? this.takeCoalescedConversationMessages(
          current,
          decision.dispatchMessageId,
        )
      : Effect.succeed([current.message]);
  }

  private runGrantedDispatch(
    current: InboundDispatchWork,
    primaryMessage: Message,
    messages: readonly Message[],
    decision: DispatchGrantDecision,
  ): Effect.Effect<boolean, unknown> {
    const dispatch = this.dispatchWithLease(
      primaryMessage.conversationId,
      messages,
      decision.leaseId,
    );
    const timeoutMs = MoltZapChannelCore.leaseTimeoutMs(decision);
    if (timeoutMs === undefined) {
      return dispatch.pipe(Effect.as(false));
    }
    return dispatch.pipe(
      Effect.timeoutFail({
        duration: Duration.millis(timeoutMs),
        onTimeout: () =>
          new DispatchLeaseExpired({
            messageId: primaryMessage.id,
            conversationId: primaryMessage.conversationId,
            timeoutMs,
          }),
      }),
      Effect.as(false),
      Effect.catchAll((err) =>
        this.handleDispatchFailure(err, current, decision),
      ),
    );
  }

  private dispatchWithLease(
    conversationId: ConversationId,
    messages: readonly Message[],
    leaseId?: LeaseId,
  ): Effect.Effect<void, unknown> {
    return Effect.sync(() => {
      const previous = this.leaseIdsInFlightByConversation.get(conversationId);
      if (leaseId === undefined) {
        this.leaseIdsInFlightByConversation.delete(conversationId);
      } else {
        this.leaseIdsInFlightByConversation.set(conversationId, leaseId);
      }
      return previous;
    }).pipe(
      Effect.flatMap((previous) =>
        this.dispatchInboundEffect(messages).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) {
                this.leaseIdsInFlightByConversation.delete(conversationId);
              } else {
                this.leaseIdsInFlightByConversation.set(
                  conversationId,
                  previous,
                );
              }
            }),
          ),
        ),
      ),
    );
  }

  private static leaseTimeoutMs(
    decision: DispatchGrantDecision,
  ): number | undefined {
    return decision.leaseId
      ? (decision.leaseTimeoutMs ?? DEFAULT_DISPATCH_LEASE_TIMEOUT_MS)
      : undefined;
  }

  private handleDispatchFailure(
    err: unknown,
    current: InboundDispatchWork,
    decision: DispatchGrantDecision,
  ): Effect.Effect<boolean, unknown> {
    if (err instanceof DispatchLeaseExpired) {
      return this.logDispatchLeaseExpired(err, current, decision);
    }
    return Effect.fail(err);
  }

  private holdDispatchWork(
    current: InboundDispatchWork,
    decision: DispatchHoldDecision,
  ): Effect.Effect<void> {
    return Effect.gen(
      function* (this: MoltZapChannelCore) {
        yield* effectLogInfo("MoltZapChannelCore: inbound dispatch held", {
          messageId: current.message.id,
          conversationId: current.message.conversationId,
          attempt: current.attempt,
          reason: decision.reason,
        });
        this.parkDispatchWork(current);
      }.bind(this),
    );
  }

  private logDispatchTargetUnavailable(
    current: InboundDispatchWork,
    decision: DispatchGrantDecision,
  ): Effect.Effect<void> {
    return effectLogWarning(
      "MoltZapChannelCore: dispatch admission target unavailable",
      {
        messageId: current.message.id,
        conversationId: current.message.conversationId,
        attempt: current.attempt,
        dispatchMessageId: decision.dispatchMessageId,
      },
    );
  }

  private logDispatchStart(
    current: InboundDispatchWork,
    primaryMessage: Message,
    messages: readonly Message[],
    decision: DispatchGrantDecision,
  ): Effect.Effect<void> {
    return effectLogInfo("MoltZapChannelCore: inbound dispatch starting", {
      messageId: primaryMessage.id,
      admittedMessageId: current.message.id,
      conversationId: current.message.conversationId,
      attempt: current.attempt,
      leaseId: decision.leaseId,
      coalescedMessageCount: messages.length,
    });
  }

  private logDispatchLeaseExpired(
    err: DispatchLeaseExpired,
    current: InboundDispatchWork,
    decision: DispatchGrantDecision,
  ): Effect.Effect<boolean> {
    return effectLogWarning(
      "MoltZapChannelCore: inbound dispatch lease expired",
      {
        messageId: err.messageId,
        conversationId: err.conversationId,
        attempt: current.attempt,
        leaseId: decision.leaseId,
        timeoutMs: err.timeoutMs,
      },
    ).pipe(Effect.as(true));
  }

  private logDispatchCompleted(
    current: InboundDispatchWork,
    primaryMessage: Message,
    decision: DispatchGrantDecision,
  ): Effect.Effect<void> {
    return effectLogInfo("MoltZapChannelCore: inbound dispatch completed", {
      messageId: primaryMessage.id,
      admittedMessageId: current.message.id,
      conversationId: current.message.conversationId,
      attempt: current.attempt,
      leaseId: decision.leaseId,
    });
  }

  private logDeniedDispatch(
    current: InboundDispatchWork,
    decision: DispatchDenyDecision,
  ): Effect.Effect<void> {
    return effectLogInfo("MoltZapChannelCore: inbound dispatch denied", {
      messageId: current.message.id,
      conversationId: current.message.conversationId,
      attempt: current.attempt,
      reason: decision.reason,
    });
  }

  private pendingDispatchSnapshot(
    active: InboundDispatchWork,
  ): readonly PendingDispatchMessage[] {
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
      parts: work.message.parts,
    }));
  }

  private takeCoalescedConversationMessages(
    work: InboundDispatchWork,
    dispatchMessageId?: string,
  ): Effect.Effect<readonly Message[]> {
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
      if (startIndex < 0) {
        return [];
      }
      return sameConversation.slice(startIndex);
    });
  }

  /**
   * Stateless enrichment helper. Falls back to `sender.id` if
   * `resolveAgentName` throws (e.g. Service not yet connected).
   * @param service Value supplied to the operation.
   * @param messageOrMessages Value supplied to the operation.
   * @returns The leased result.
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
        const registration = this.inboundHandlerRegistration;
        if (registration === null) {
          return;
        }
        const { enriched, commitContext } =
          yield* MoltZapChannelCore.enrichMessage(this.service, messages);
        const leaseId = this.leaseIdsInFlightByConversation.get(
          enriched.conversationId,
        );
        const leased =
          leaseId !== undefined
            ? { ...enriched, dispatchLeaseId: leaseId }
            : enriched;
        // The handler is user code returning an Effect — yield it directly so
        // its typed error channel propagates to the consumer fiber, which logs
        // and continues. We await it inline to preserve arrival-order delivery.
        yield* registration.handler(leased);
        if (commitContext) {
          commitContext();
        }
      }.bind(this),
    );
  }
}
