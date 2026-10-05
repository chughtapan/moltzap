/**
 * @file The engine kernel: the dependencies one endpoint engine is built
 * from and the state every phase reads. It holds no phase logic, so every
 * phase can depend on it without depending on another phase.
 */

import type {
  AgentId,
  AgentSigningAuthority,
  Ed25519PublicKey,
  SignedMessage,
  VerifiedAgentCard,
} from "@moltzap/identity";
import type { Deferred, Effect, Queue } from "effect";
import type { EndpointStore } from "../../../store/index.js";
import type {
  RouterIngressDisposition,
  RouterTailAnchor,
  RouterWorkerIngress,
  RouterWorkerPersistenceError,
  RouterWorkerSendError,
  RouterWorkerUnavailableError,
} from "../../router/index.js";
import type {
  ActionCertifiedRecord,
  ActionCore,
  ActionHash,
  CertifiedRecord,
  ConversationId,
  DecodedOuterBody,
  PostIntent,
  RecordHash,
  RouterAnchor,
  VerifiedMembership,
} from "../../wire/index.js";
import type { AddressRegistryPort } from "../address.js";
import type { SendError } from "../errors.js";

/** RouterWorker operations consumed by the engine's outbound queue. */
interface EngineRouterPort {
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

/** Stable private dependencies for one endpoint protocol engine. */
export interface EndpointEngineInput {
  readonly localAgentCard: VerifiedAgentCard;
  readonly signingAuthority: AgentSigningAuthority;
  readonly registrySignerPublicKey: Ed25519PublicKey;
  readonly registry: AddressRegistryPort;
  readonly store: EndpointStore;
  readonly routerWorker: EngineRouterPort;
  readonly actionPolicy: EngineActionPolicy;
}

/** One locally authored immutable post intent awaiting certification. */
export interface EnginePostIntent {
  readonly intent: PostIntent;
  readonly canonicalIntent: Uint8Array;
  readonly completion: Deferred.Deferred<RecordHash, SendError>;
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
  localDurabilityEvidenceQueued: boolean;
  recordHash?: RecordHash;
  certifiedRecord?: CertifiedRecord;
}

/**
 * Open an empty fold for one action: no evidence, and no local signature
 * queued yet, so certification decides what to sign and send.
 * @param conversation Conversation whose next position the action proposes.
 * @param action Selected action the fold collects evidence for.
 * @param actionHash Hash that action and durability evidence name.
 * @param routerAnchor Anchor the action's record certifies against.
 * @returns A fold the caller registers in `EngineRuntime.actionFolds`.
 */
export function makeActionFold(
  conversation: EngineConversation,
  action: ActionCore,
  actionHash: ActionHash,
  routerAnchor: RouterAnchor,
): EngineActionFold {
  return {
    conversation,
    action,
    actionHash,
    routerAnchor,
    actionEvidence: new Map(),
    durabilityEvidence: new Map(),
    localActionEvidenceQueued: false,
    localDurabilityEvidenceQueued: false,
  };
}

/** Shared acquired state used by addressed send and protocol ingress. */
export interface EngineRuntime {
  readonly input: EndpointEngineInput;
  readonly conversations: Map<ConversationId, EngineConversation>;
  readonly intents: Map<string, EnginePostIntent>;
  /** Locally complete post ids and the hash of each one's certified record. */
  readonly completedPosts: Map<string, RecordHash>;
  readonly actionFolds: Map<ActionHash, EngineActionFold>;
  readonly recordFolds: Map<RecordHash, EngineActionFold>;
  readonly outbound: string[];
  readonly outboundSignal: Queue.Queue<undefined>;
  readonly gate: Effect.Semaphore;
  readonly outboundGate: Effect.Semaphore;
  readonly phases: EnginePhases;
}

/**
 * The operations one engine phase starts in another. The engine assembly
 * supplies them, so send, certification, dissemination and recovery depend
 * on this contract instead of on each other.
 */
export interface EnginePhases {
  readonly proposeIntent: (
    runtime: EngineRuntime,
    intent: EnginePostIntent,
  ) => Effect.Effect<ActionHash, SendError>;
  readonly queueCertifiedPacket: (
    runtime: EngineRuntime,
    conversation: EngineConversation,
    packet: ActionCertifiedRecord | CertifiedRecord,
  ) => Effect.Effect<void, SendError>;
  readonly queueEvidence: (
    runtime: EngineRuntime,
    conversation: EngineConversation,
    evidence: SignedMessage,
  ) => Effect.Effect<void, SendError>;
  readonly acceptIngress: (
    runtime: EngineRuntime,
    ingress: RouterWorkerIngress<DecodedOuterBody>,
  ) => Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError>;
  readonly acceptRecoveryIngress: (
    runtime: EngineRuntime,
    ingress: RouterWorkerIngress<DecodedOuterBody>,
  ) => Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError>;
  readonly resumeFolds: (
    runtime: EngineRuntime,
  ) => Effect.Effect<void, RouterWorkerPersistenceError>;
  readonly resumeDissemination: (
    runtime: EngineRuntime,
  ) => Effect.Effect<void, RouterWorkerPersistenceError>;
}
