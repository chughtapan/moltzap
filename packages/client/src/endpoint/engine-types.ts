/** @file Private addressed-message engine contracts for daemon composition. */

import type {
  AgentId,
  AgentSigningAuthority,
  Ed25519PublicKey,
  SignedMessage,
  VerifiedAgentCard,
} from "@moltzap/identity";
import type { Registry } from "@moltzap/identity/registry";
import {
  type Context,
  Data,
  type Deferred,
  type Duration,
  type Effect,
  type Queue,
  type SubscriptionRef,
} from "effect";
import type {
  DeliveryAcknowledgeError,
  HistoryExportRecord,
  InboundMessage,
  ListenError,
  SendError,
  SendInput,
} from "../contract.js";
import type {
  ActionCore,
  ActionHash,
  CertifiedRecord,
  ConversationId,
  DecodedOuterBody,
  PostIntent,
  RecordHash,
  RouterAnchor,
  VerifiedMembership,
} from "./representation.js";
import type {
  RouterDiscontinuityReason,
  RouterIngressDisposition,
  RouterTailAnchor,
  RouterWorkerIngress,
  RouterWorkerPersistenceError,
  RouterWorkerRecovery,
  RouterWorkerRecoveryError,
  RouterWorkerSendError,
  RouterWorkerUnavailableError,
} from "./router-worker/index.js";
import type { DeliveryToken, EndpointStore } from "./store.js";

/** Engine acquisition could not establish one coherent durable endpoint. */
export class EngineInitializationError extends Data.TaggedError(
  "EngineInitializationError",
)<{
  readonly reason: "identity" | "persistence" | "representation";
}> {}

/** Sending queued protocol traffic could not complete safely. */
export class EngineOutboundError extends Data.TaggedError(
  "EngineOutboundError",
)<{
  readonly reason: "network" | "persistence" | "representation";
}> {}

/** One durable delivery decoded for the daemon's sole subscriber. */
export interface EnginePendingMessage {
  readonly deliveryToken: DeliveryToken;
  readonly message: InboundMessage;
}

/** Minimal Registry capability used to resolve immutable peer cards. */
export type EngineRegistryPort = Pick<
  Context.Tag.Service<typeof Registry>,
  "lookup"
>;

/** RouterWorker operations consumed by the engine's outbound queue. */
export interface EngineRouterPort {
  readonly currentAnchor: Effect.Effect<
    RouterTailAnchor,
    RouterWorkerUnavailableError
  >;
  readonly awaitAnchor: Effect.Effect<RouterTailAnchor>;
  readonly send: (
    outboundId: string,
  ) => Effect.Effect<void, RouterWorkerSendError>;
}

/** Closed result of the endpoint's local action-signing policy. */
export type EngineActionPolicyDecision = "sign" | "refuse";

/** Verified action context presented to local task, norm, and trust policy. */
export interface EngineActionPolicyInput {
  readonly action: ActionCore;
  readonly membership: VerifiedMembership;
}

/** Endpoint-local policy invoked before creating an action signature. */
export type EngineActionPolicy = (
  input: EngineActionPolicyInput,
) => Effect.Effect<EngineActionPolicyDecision>;

/**
 * Sink for the daemon's optional history export. Recording never fails and
 * never blocks the protocol on its own outcome: an export that stops is the
 * sink's business, recorded in the file, not the engine's.
 */
export interface HistoryExportPort {
  readonly record: (record: HistoryExportRecord) => Effect.Effect<void>;
}

/** Stable private dependencies for one endpoint protocol engine. */
export interface EndpointEngineInput {
  readonly localAgentCard: VerifiedAgentCard;
  readonly signingAuthority: AgentSigningAuthority;
  readonly registrySignerPublicKey: Ed25519PublicKey;
  readonly registry: EngineRegistryPort;
  readonly store: EndpointStore;
  readonly routerWorker: EngineRouterPort;
  readonly actionPolicy: EngineActionPolicy;
  /** Overrides `ROUTER_ATTACH_TIMEOUT`; tests bound the wait in milliseconds. */
  readonly routerAttachTimeout?: Duration.Duration;
  /** Present only when the operator configured a history export. */
  readonly historyExport?: HistoryExportPort;
}

/** Stable private engine capability consumed by daemon composition. */
export interface EndpointEngine {
  readonly send: (input: SendInput) => Effect.Effect<void, SendError>;
  readonly readPendingMessages: () => Effect.Effect<
    readonly EnginePendingMessage[],
    ListenError
  >;
  readonly acknowledgeMessage: (
    deliveryToken: DeliveryToken,
  ) => Effect.Effect<void, DeliveryAcknowledgeError>;
  readonly acceptRouterIngress: (
    ingress: RouterWorkerIngress<DecodedOuterBody>,
  ) => Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError>;
  readonly acceptRecoveryIngress: (
    ingress: RouterWorkerIngress<DecodedOuterBody>,
  ) => Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError>;
  readonly recoverCertifiedHistory: (
    recovery: RouterWorkerRecovery,
  ) => Effect.Effect<void, RouterWorkerRecoveryError | RouterWorkerSendError>;
  readonly drainOutbound: Effect.Effect<void, EngineOutboundError>;
  readonly runOutbound: Effect.Effect<never, EngineOutboundError>;
  readonly abandonVolatileFolds: (
    reason: RouterDiscontinuityReason,
  ) => Effect.Effect<void>;
}

/** One locally authored immutable post intent awaiting certification. */
export interface EnginePostIntent {
  readonly intent: PostIntent;
  readonly canonicalIntent: Uint8Array;
  readonly completion: Deferred.Deferred<undefined, SendError>;
  proposedActionHash?: ActionHash;
}

/** One locally complete history head. */
export interface EngineCertifiedHead {
  readonly recordHash: RecordHash;
  readonly record: CertifiedRecord;
}

/** Immutable membership with the endpoint's current durable position. */
export interface EngineConversation {
  readonly conversationId: ConversationId;
  readonly membership: VerifiedMembership;
  currentAnchor: RouterAnchor;
  head?: EngineCertifiedHead;
}

/** Volatile evidence fold for the selected action at one predecessor. */
export interface EngineActionFold {
  readonly conversation: EngineConversation;
  readonly action: ActionCore;
  readonly actionHash: ActionHash;
  readonly routerAnchor: RouterAnchor;
  readonly actionEvidence: Map<AgentId, SignedMessage>;
  readonly durabilityEvidence: Map<AgentId, SignedMessage>;
  localActionEvidenceQueued: boolean;
  actionCertifiedRecordQueued: boolean;
  localDurabilityEvidenceQueued: boolean;
  certifiedRecordQueued: boolean;
  recordHash?: RecordHash;
  certifiedRecord?: CertifiedRecord;
}

/** Shared acquired state used by addressed send and protocol ingress. */
export interface EngineRuntime {
  readonly input: EndpointEngineInput;
  readonly conversations: Map<ConversationId, EngineConversation>;
  readonly intents: Map<string, EnginePostIntent>;
  readonly completedPostIds: Set<string>;
  readonly actionFolds: Map<ActionHash, EngineActionFold>;
  readonly recordFolds: Map<RecordHash, EngineActionFold>;
  readonly outbound: string[];
  readonly outboundSignal: Queue.Queue<undefined>;
  readonly gate: Effect.Semaphore;
  readonly outboundGate: Effect.Semaphore;
  readonly revision: SubscriptionRef.SubscriptionRef<number>;
}
