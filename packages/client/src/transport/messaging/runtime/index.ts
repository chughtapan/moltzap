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
import type { Deferred, Effect } from "effect";
import type {
  EndpointStore,
  EndpointStoreError,
} from "../../../store/index.js";
import type {
  RouterIngressDisposition,
  RouterWorker,
  RouterWorkerIngress,
  RouterWorkerPersistenceError,
  RouterWorkerSendError,
} from "../../router/index.js";
import type {
  ActionCore,
  ActionHash,
  CertifiedRecord,
  ClientRepresentationError,
  ConversationId,
  DecodedOuterBody,
  DirectPacket,
  PostActionCore,
  PostIntent,
  RecordHash,
  RouterAnchor,
  VerifiedMembership,
} from "../../wire/index.js";
import type { AddressRegistryPort } from "../address.js";
import type { SendError } from "../errors.js";

/** RouterWorker operations consumed by the engine's outbound queue. */
type EngineRouterPort = Pick<
  RouterWorker,
  "currentAnchor" | "awaitAnchor" | "send"
>;

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

/**
 * A verified POST proposal naming a position this endpoint does not hold yet,
 * with the action signatures members send for it while catch-up runs. They
 * are not sent again, and the proposal may need them to reach its threshold
 * here. One signature ingress per member, the latest verified one, is kept.
 */
export interface EngineWaitingProposal {
  readonly conversation: EngineConversation;
  readonly action: PostActionCore;
  readonly actionHash: ActionHash;
  readonly proposal: RouterWorkerIngress<DecodedOuterBody>;
  readonly signatures: Map<AgentId, RouterWorkerIngress<DecodedOuterBody>>;
  /**
   * Whether `f + 1` members signed it, so at least one honest member locked
   * it: only then does this endpoint ask for history or lock the proposal.
   */
  vouched: boolean;
}

/** A verified durability vote naming a record this endpoint has not staged. */
export interface EngineEarlyVote {
  readonly recordHash: RecordHash;
  readonly ingress: RouterWorkerIngress<DecodedOuterBody>;
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
  /**
   * Per conversation, at most one waiting proposal per author, so a faulty
   * member's proposals replace only its own. A Router discontinuity drops them
   * all.
   */
  readonly waitingProposals: Map<
    ConversationId,
    Map<AgentId, EngineWaitingProposal>
  >;
  /**
   * Per conversation, each member's latest durability vote naming a record
   * not staged here, applied once that record is staged. A member that sends
   * its evidence again in a catch-up answer sends its vote right after its
   * signature, before the signatures can let this endpoint stage the record.
   * A Router discontinuity drops them.
   */
  readonly earlyVotes: Map<ConversationId, Map<AgentId, EngineEarlyVote>>;
  readonly gate: Effect.Semaphore;
  readonly outbox: EngineOutbox;
  readonly phases: EnginePhases;
}

/**
 * Why the outbox could not stage an envelope: signing or canonical encoding
 * failed, or the store refused the row. Each phase maps it to its own error.
 */
export type EngineOutboxError = ClientRepresentationError | EndpointStoreError;

/**
 * The engine's outbox: the only caller of the outer-envelope signers, so the
 * engine builds and signs every outer body here; the Router worker's retry
 * re-signs a staged body unchanged. Its queue operations always stage the
 * signed envelope durably and queue its outbox identity for the Router
 * worker; `sign` serves a caller that routes the envelope itself. Phases
 * reach it only through `EngineRuntime.outbox`.
 */
export interface EngineOutbox {
  /** Sign an envelope for a caller that routes it, as recovery does. */
  readonly sign: (
    membership: VerifiedMembership,
    body: DecodedOuterBody,
  ) => Effect.Effect<SignedMessage, ClientRepresentationError>;
  readonly queuePacket: (
    conversation: EngineConversation,
    packet: DirectPacket,
  ) => Effect.Effect<void, EngineOutboxError>;
  /** Relay stable inner evidence; its signer attribution is unchanged. */
  readonly queueEvidence: (
    conversation: EngineConversation,
    evidence: SignedMessage,
  ) => Effect.Effect<void, EngineOutboxError>;
  /**
   * Stage an envelope that `sign` returned; any other `SignedMessage` would
   * skip the outbox's signing.
   */
  readonly enqueueSigned: (
    conversationId: ConversationId,
    message: SignedMessage,
  ) => Effect.Effect<void, EngineOutboxError>;
  readonly resume: (outboundIds: readonly string[]) => Effect.Effect<void>;
  /** Forget every queued identity; the store keeps the envelopes. */
  readonly clear: () => void;
  /** Run `effect` while no drain reads or removes the queue head. */
  readonly serialized: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly drain: Effect.Effect<void, RouterWorkerSendError>;
  /** Drain on every wake; ends only with a fatal worker failure. */
  readonly run: Effect.Effect<never, RouterWorkerSendError>;
}

/**
 * The operations one engine phase starts in another. The engine assembly
 * supplies them, so send, certification and recovery depend on this contract
 * instead of on each other.
 */
export interface EnginePhases {
  readonly proposeIntent: (
    runtime: EngineRuntime,
    intent: EnginePostIntent,
  ) => Effect.Effect<ActionHash, SendError>;
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
  /**
   * Ask every other member for the certified history after this endpoint's
   * durable position in one conversation, as certification does when a
   * proposal names a predecessor this endpoint does not hold.
   */
  readonly requestCatchUp: (
    runtime: EngineRuntime,
    conversationId: ConversationId,
  ) => Effect.Effect<void, RouterWorkerPersistenceError>;
  /**
   * Accept a conversation's waiting proposal that now fits, as catch-up does
   * after applying a completed re-anchor.
   */
  readonly acceptWaitingProposals: (
    runtime: EngineRuntime,
    conversationId: ConversationId,
  ) => Effect.Effect<void, RouterWorkerPersistenceError>;
}
