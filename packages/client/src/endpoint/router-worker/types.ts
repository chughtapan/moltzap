/** @file Private Router worker contracts shared by orchestration and transport. */

import type {
  AgentId,
  AgentSigningAuthority,
  MessageId,
  SignedMessage,
  VerifiedAgentCard,
  VerifiedSignedMessage,
} from "@moltzap/identity";
import type { Registry } from "@moltzap/identity/registry";
import type { PollCursor, Router, RouterInstanceId } from "@moltzap/router";
import {
  type Context,
  Data,
  type Effect,
  Schedule,
  type SubscriptionRef,
} from "effect";
import type { DecodedOuterBody } from "../representation.js";
import type { EndpointStore } from "../store.js";

/** An outer sender card could not be resolved, pinned, or authenticated. */
export class RouterWorkerAuthenticationError extends Data.TaggedError(
  "RouterWorkerAuthenticationError",
) {}

/** Endpoint state needed for cursor advancement could not be persisted. */
export class RouterWorkerPersistenceError extends Data.TaggedError(
  "RouterWorkerPersistenceError",
) {}

/** An authenticated outer body is not one closed Client protocol value. */
export class RouterWorkerPayloadInvalidError extends Data.TaggedError(
  "RouterWorkerPayloadInvalidError",
) {}

/** Router communication exhausted its bounded retry allowance. */
export class RouterWorkerTransportError extends Data.TaggedError(
  "RouterWorkerTransportError",
) {}

/** A Router outcome or local envelope violated the private worker contract. */
export class RouterWorkerProtocolError extends Data.TaggedError(
  "RouterWorkerProtocolError",
) {}

/** Certified-history recovery did not complete for the current Router tail. */
export class RouterWorkerRecoveryError extends Data.TaggedError(
  "RouterWorkerRecoveryError",
) {}

/** A caller must resume protocol work from the recovered certified position. */
export class RouterWorkerDiscontinuityError extends Data.TaggedError(
  "RouterWorkerDiscontinuityError",
) {}

/** A normal send was attempted while the worker is detached or recovering. */
export class RouterWorkerUnavailableError extends Data.TaggedError(
  "RouterWorkerUnavailableError",
) {}

/** Closed reason for abandoning process-local protocol folds. */
export type RouterDiscontinuityReason =
  | "feed_gap"
  | "cursor_invalid"
  | "router_restarted";

/** Empty-tail Router position learned from an omitted-cursor poll. */
export interface RouterTailAnchor {
  readonly routerInstanceId: RouterInstanceId;
  readonly pollCursor: PollCursor;
}

/** A verified protocol input either changed durable state or was conclusively irrelevant. */
export type RouterIngressDisposition = "accepted" | "ignored";

/** Closed failures returned by initial and recovery sends. */
export type RouterWorkerSendError =
  | RouterWorkerAuthenticationError
  | RouterWorkerPersistenceError
  | RouterWorkerTransportError
  | RouterWorkerProtocolError
  | RouterWorkerRecoveryError
  | RouterWorkerDiscontinuityError
  | RouterWorkerUnavailableError;

/** Closed failures returned by one poll/recovery transition. */
export type RouterWorkerPollError =
  | RouterWorkerAuthenticationError
  | RouterWorkerPersistenceError
  | RouterWorkerTransportError
  | RouterWorkerProtocolError
  | RouterWorkerRecoveryError
  | RouterWorkerDiscontinuityError
  | RouterWorkerUnavailableError;

/** Verified outer message and its decoded private Client payload. */
export interface RouterWorkerIngress<Payload> {
  readonly routerInstanceId: RouterInstanceId;
  readonly message: VerifiedSignedMessage;
  readonly senderCard: VerifiedAgentCard;
  readonly payload: Payload;
}

/** Discontinuity recovery input after learning the new empty tail. */
export interface RouterWorkerRecovery {
  readonly reason: RouterDiscontinuityReason;
  readonly anchor: RouterTailAnchor;
  readonly resume: (
    outboundId: string,
  ) => Effect.Effect<void, RouterWorkerSendError>;
  readonly send: (
    input: RouterWorkerRecoverySend,
  ) => Effect.Effect<void, RouterWorkerSendError>;
}

/** One recovery-only message before its complete outer envelope is retained. */
export interface RouterWorkerRecoverySend {
  readonly conversationId: string;
  readonly message: SignedMessage;
}

/** Durable operations required by the Router transport and no other worker path. */
type RouterWorkerOutbox = Pick<
  EndpointStore,
  "enqueueOutbound" | "beginOutbound" | "replaceOutbound" | "completeOutbound"
>;

/** Private endpoint callbacks around the Router worker's ordering boundary. */
export interface RouterWorkerCallbacks<Payload = DecodedOuterBody> {
  readonly pinSenderCard: (
    card: VerifiedAgentCard,
  ) => Effect.Effect<void, RouterWorkerPersistenceError>;
  readonly decodePayload: (
    message: VerifiedSignedMessage,
  ) => Effect.Effect<Payload, RouterWorkerPayloadInvalidError>;
  readonly acceptPayload: (
    input: RouterWorkerIngress<Payload>,
  ) => Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError>;
  readonly acceptRecoveryPayload: (
    input: RouterWorkerIngress<Payload>,
  ) => Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError>;
  readonly abandonVolatileFolds: (
    reason: RouterDiscontinuityReason,
  ) => Effect.Effect<void>;
  readonly recoverCertifiedHistory: (
    input: RouterWorkerRecovery,
  ) => Effect.Effect<void, RouterWorkerRecoveryError | RouterWorkerSendError>;
}

/** Focused test seams that retain production postconditions. */
interface RouterWorkerOverrides {
  readonly verifyOuter?: (input: {
    readonly signedMessage: SignedMessage;
    readonly agentCard: VerifiedAgentCard;
  }) => Effect.Effect<VerifiedSignedMessage, RouterWorkerAuthenticationError>;
  readonly rewrapOuter?: (input: {
    readonly signedMessage: SignedMessage;
    readonly messageId: MessageId;
  }) => Effect.Effect<SignedMessage, RouterWorkerProtocolError>;
  readonly makeMessageId?: () => Effect.Effect<
    MessageId,
    RouterWorkerProtocolError
  >;
}

/** Complete private construction input for one registered endpoint. */
export interface RouterWorkerInput<Payload = DecodedOuterBody> {
  readonly callerAgentId: AgentId;
  readonly callerAgentCard: VerifiedAgentCard;
  /** Durable membership cards available before Registry connectivity. */
  readonly pinnedSenderCards: readonly VerifiedAgentCard[];
  readonly signingAuthority: AgentSigningAuthority;
  readonly outbox: RouterWorkerOutbox;
  readonly callbacks: RouterWorkerCallbacks<Payload>;
  /** Test seams preserve production postconditions and are not process configuration. */
  readonly overrides?: RouterWorkerOverrides;
}

/** One endpoint-wide Router worker. */
export interface RouterWorker {
  readonly currentAnchor: Effect.Effect<
    RouterTailAnchor,
    RouterWorkerUnavailableError
  >;
  /**
   * The active anchor as soon as one exists: the current anchor while the
   * worker is active, otherwise the anchor the next answered poll or
   * completed recovery publishes. Callers bound the wait; the worker itself
   * never gives up.
   */
  readonly awaitAnchor: Effect.Effect<RouterTailAnchor>;
  readonly pollOnce: Effect.Effect<void, RouterWorkerPollError>;
  /**
   * Polls for the endpoint's lifetime. A transient failure detaches the
   * worker and backs off until the Router answers; only a non-transient
   * failure ends the loop.
   */
  readonly run: Effect.Effect<never, RouterWorkerPollError>;
  readonly send: (
    outboundId: string,
  ) => Effect.Effect<void, RouterWorkerSendError>;
}

/** Volatile cursor state for an active Router instance. */
export interface RouterWorkerActiveState {
  readonly kind: "active";
  readonly generation: number;
  readonly anchor: RouterTailAnchor;
}

/** Volatile discontinuity state while certified history is reconciled. */
export interface RouterWorkerRecoveringState {
  readonly kind: "recovering";
  readonly generation: number;
  readonly reason: RouterDiscontinuityReason;
  readonly priorRouterInstanceId?: RouterInstanceId;
  readonly volatileFoldsAbandoned: boolean;
  readonly anchor?: RouterTailAnchor;
}

/**
 * Volatile cursor state while the Router stops answering an active worker.
 * The next answered poll either reattaches at the same anchor or starts
 * recovery, so no send runs until the Router's instance is known again.
 */
export interface RouterWorkerDetachedState {
  readonly kind: "detached";
  readonly generation: number;
  readonly anchor: RouterTailAnchor;
}

/** Closed volatile lifecycle of the Router worker. */
export type RouterWorkerState =
  | RouterWorkerActiveState
  | RouterWorkerDetachedState
  | RouterWorkerRecoveringState;

/** Resolved public capabilities consumed by private worker mechanics. */
export interface RouterWorkerServices {
  readonly router: Context.Tag.Service<typeof Router>;
  readonly registry: Context.Tag.Service<typeof Registry>;
}

/** Shared mutable worker runtime, guarded by its three semaphores. */
export interface RouterWorkerRuntime<Payload> extends RouterWorkerServices {
  readonly input: RouterWorkerInput<Payload>;
  readonly cards: Map<AgentId, VerifiedAgentCard>;
  readonly state: SubscriptionRef.SubscriptionRef<RouterWorkerState>;
  readonly pollGate: Effect.Semaphore;
  readonly stateGate: Effect.Semaphore;
  readonly recoveryGate: Effect.Semaphore;
}

/** Outer message with both sender card and signature verified. */
export interface RouterWorkerVerifiedIngress {
  readonly message: VerifiedSignedMessage;
  readonly senderCard: VerifiedAgentCard;
}

/** Router send outcome relevant above transport representation. */
export type RouterWorkerSendOutcome =
  | Readonly<{ kind: "accepted" }>
  | Readonly<{ kind: "restarted" }>;

/** Complete number of attempts for one ambiguous transport operation. */
export const routerWorkerRetryAttempts = 3;
/** Fixed interruptible spacing between bounded attempts. */
export const routerWorkerRetryDelay = "25 millis";

/**
 * Backoff for work that waits out an unreachable or re-anchoring Router: the
 * poll loop and the outbound drain. It never ends, because a Router outage
 * halts progress rather than failing the endpoint.
 */
export const routerWorkerReconnectSchedule = Schedule.exponential(
  "100 millis",
).pipe(Schedule.union(Schedule.spaced("5 seconds")));

const transientByTag = {
  RouterWorkerAuthenticationError: false,
  RouterWorkerDiscontinuityError: true,
  RouterWorkerPersistenceError: false,
  RouterWorkerProtocolError: false,
  RouterWorkerRecoveryError: false,
  RouterWorkerTransportError: true,
  RouterWorkerUnavailableError: true,
} as const satisfies Readonly<Record<RouterWorkerPollError["_tag"], boolean>>;

/**
 * Whether a worker failure ends once the Router answers and the worker
 * re-anchors. Every other failure is a protocol, persistence, or recovery
 * fault that stays fatal.
 * @param error Poll or send failure; both unions share these tags.
 * @returns True for transport loss, a pending recovery, or a discontinuity.
 */
export const isTransientRouterWorkerError = (
  error: RouterWorkerPollError | RouterWorkerSendError,
): boolean => transientByTag[error._tag];
