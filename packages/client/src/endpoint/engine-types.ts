/** @file Private endpoint engine contracts for daemon composition. */

import type {
  AgentId,
  AgentSigningAuthority,
  Ed25519PublicKey,
  SignedMessage,
  VerifiedAgentCard,
} from "@moltzap/identity";
import type { Registry } from "@moltzap/identity/registry";
import {
  Data,
  type Deferred,
  type Effect,
  type Queue,
  type Scope,
  type SubscriptionRef,
} from "effect";
import type { Content, ConversationId, StartInput } from "../contract.js";
import type { ReplyGrant } from "../harness-runtime.js";
import type {
  DecodedOuterBody,
  Action,
  ActionCertifiedRecord,
  BeginDigest,
  CertifiedRecord,
  CompletedReanchor,
  GenesisAnchor,
  MulticastAction,
  RecordHash,
  StartAction,
  VerifiedMembership,
} from "./representation.js";
import type {
  RouterDiscontinuityReason,
  RouterIngressDisposition,
  RouterTailAnchor,
  RouterWorkerIngress,
  RouterWorkerPersistenceError,
  RouterWorkerSendError,
  RouterWorkerUnavailableError,
} from "./router-worker.js";
import type { EndpointStore } from "./store.js";

/** Engine acquisition could not establish one coherent durable endpoint. */
export class EngineInitializationError extends Data.TaggedError(
  "EngineInitializationError",
)<{
  readonly reason: "identity" | "persistence" | "representation";
}> {}

/** Closed private START failure mapped directly by the daemon boundary. */
export class EngineStartError extends Data.TaggedError("EngineStartError")<{
  readonly reason:
    | "intent-conflict"
    | "not-registered"
    | "membership"
    | "persistence"
    | "durability"
    | "reanchor"
    | "representation";
}> {}

/** Closed failure for one admitted bound MULTICAST reply. */
export class EngineReplyError extends Data.TaggedError("EngineReplyError")<{
  readonly reason:
    | "authority-unavailable"
    | "persistence"
    | "durability"
    | "reanchor"
    | "representation";
}> {}

/** Sending queued protocol traffic could not complete safely. */
export class EngineOutboundError extends Data.TaggedError(
  "EngineOutboundError",
)<{
  readonly reason: "durability" | "persistence" | "reanchor" | "representation";
}> {}

/** A second runtime listener attempted to own the endpoint. */
export class EngineListenerInUseError extends Data.TaggedError(
  "EngineListenerInUseError",
) {}

/** An eligible head could not enter the task-owned attention protocol. */
export class EngineAttentionError extends Data.TaggedError(
  "EngineAttentionError",
) {}

/** No active listener or eligible certified head authorizes delivery. */
export class EngineAttentionUnavailableError extends Data.TaggedError(
  "EngineAttentionUnavailableError",
) {}

/** The daemon could not write one complete turn frame. */
export class EngineTurnWriteError extends Data.TaggedError(
  "EngineTurnWriteError",
) {}

/** Complete semantic turn bytes passed to the sole daemon listener. */
export interface EngineTurnFrame {
  readonly conversationId: ConversationId;
  readonly peers: readonly [VerifiedAgentCard, ...VerifiedAgentCard[]];
  readonly author: VerifiedAgentCard;
  readonly content: Content;
  readonly replyGrant: ReplyGrant;
}

/** Task-owned live authority proposed for at-most-once runtime delivery. */
export interface EngineProspectiveTurn extends EngineTurnFrame {
  readonly recordHash: string;
}

/** Complete-frame writer owned by the daemon subscription. */
export interface EngineTurnSink {
  readonly write: (
    turn: EngineTurnFrame,
  ) => Effect.Effect<void, EngineTurnWriteError>;
}

/** Scoped ownership token for the endpoint's sole turn listener. */
export interface EngineTurnListener {
  readonly detach: Effect.Effect<void>;
}

/** Minimal Registry capability used to resolve immutable peer cards. */
export type EngineRegistryPort = Pick<
  import("effect").Context.Tag.Service<typeof Registry>,
  "lookup"
>;

/** RouterWorker operations consumed by the engine's outbound queue. */
export interface EngineRouterPort {
  readonly currentAnchor: Effect.Effect<
    RouterTailAnchor,
    RouterWorkerUnavailableError
  >;
  readonly send: (
    message: SignedMessage,
  ) => Effect.Effect<void, RouterWorkerSendError>;
}

/** Stable private dependencies for one endpoint protocol engine. */
export interface EndpointEngineInput {
  readonly localAgentCard: VerifiedAgentCard;
  readonly signingAuthority: AgentSigningAuthority;
  readonly registrySignerPublicKey: Ed25519PublicKey;
  readonly registry: EngineRegistryPort;
  readonly store: EndpointStore;
  readonly routerWorker: EngineRouterPort;
}

/** Stable private engine capability consumed by daemon composition. */
export interface EndpointEngine {
  readonly start: (input: StartInput) => Effect.Effect<void, EngineStartError>;
  readonly reply: (
    grant: ReplyGrant,
    content: Content,
  ) => Effect.Effect<void, EngineReplyError>;
  readonly acceptRouterIngress: (
    ingress: RouterWorkerIngress<DecodedOuterBody>,
  ) => Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError>;
  readonly acceptRecoveryIngress: (
    ingress: RouterWorkerIngress<DecodedOuterBody>,
  ) => Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError>;
  readonly recoverCertifiedHistory: (
    recovery: import("./router-worker.js").RouterWorkerRecovery,
  ) => Effect.Effect<
    void,
    | import("./router-worker.js").RouterWorkerRecoveryError
    | RouterWorkerSendError
  >;
  readonly drainOutbound: Effect.Effect<void, EngineOutboundError>;
  readonly runOutbound: Effect.Effect<never, EngineOutboundError>;
  readonly abandonVolatileFolds: (
    reason: RouterDiscontinuityReason,
  ) => Effect.Effect<void>;
  readonly acquireTurnSink: (
    sink: EngineTurnSink,
  ) => Effect.Effect<
    EngineTurnListener,
    EngineListenerInUseError | EngineAttentionError,
    Scope.Scope
  >;
  readonly deliverTurn: (
    turn: EngineProspectiveTurn,
  ) => Effect.Effect<
    void,
    | EngineAttentionUnavailableError
    | EngineTurnWriteError
    | RouterWorkerPersistenceError
  >;
}

/** One START fold reconstructed from durable state. */
interface EngineActionFoldState {
  readonly conversationId: ConversationId;
  readonly membership: VerifiedMembership;
  readonly actionSignatures: Map<AgentId, SignedMessage>;
  readonly durabilityVotes: Map<AgentId, SignedMessage>;
  actionSignatureQueued: boolean;
  durabilityVoteQueued: boolean;
  certifiedBroadcastQueued: boolean;
  actionCertifiedRecord?: ActionCertifiedRecord;
  recordHash?: RecordHash;
  certifiedRecord?: CertifiedRecord;
}

/** Durable current action projection, independent of its retained fold. */
export interface EngineCertifiedHead {
  readonly recordHash: RecordHash;
  readonly action: Action;
  readonly certifiedRecord: CertifiedRecord;
}

/** START fold and the durable current head for one fixed conversation. */
export interface EngineConversation extends EngineActionFoldState {
  readonly foldKind: "start";
  readonly conversationId: ConversationId;
  readonly canonicalIntent: Uint8Array;
  readonly membership: VerifiedMembership;
  readonly genesisAnchor: GenesisAnchor;
  readonly action: StartAction;
  currentAnchor: GenesisAnchor | CompletedReanchor;
  head?: EngineCertifiedHead;
}

/** One volatile MULTICAST fold keyed by its authenticated BEGIN digest. */
export interface EngineMulticastFold extends EngineActionFoldState {
  readonly foldKind: "multicast";
  readonly beginDigest: BeginDigest;
  readonly action: MulticastAction;
  readonly routerAnchor: GenesisAnchor | CompletedReanchor;
  readonly completion: Deferred.Deferred<void, EngineReplyError>;
}

/** Common action-certification and durability state. */
export type EngineActionFold = EngineConversation | EngineMulticastFold;

/** Shared acquired state used by the engine's focused owners. */
export interface EngineRuntime {
  readonly input: EndpointEngineInput;
  readonly conversations: Map<ConversationId, EngineConversation>;
  readonly multicastFolds: Map<BeginDigest, EngineMulticastFold>;
  readonly recordFolds: Map<RecordHash, EngineActionFold>;
  readonly completions: Map<
    ConversationId,
    Deferred.Deferred<void, EngineStartError>
  >;
  readonly outbound: SignedMessage[];
  readonly outboundSignal: Queue.Queue<void>;
  readonly gate: Effect.Semaphore;
  readonly outboundGate: Effect.Semaphore;
  readonly listenerGate: Effect.Semaphore;
  readonly revision: SubscriptionRef.SubscriptionRef<number>;
  openFloor?: import("./openfloor.js").OpenFloorPort;
  activeSink?: EngineTurnSink;
}
