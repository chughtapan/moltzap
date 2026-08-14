/** @file Private volatile OpenFloorV1 contention and action-admission contracts. */

import type {
  AgentSigningAuthority,
  SignedMessage,
  VerifiedAgentCard,
} from "@moltzap/identity";
import type { Effect } from "effect";
import type { Content, ConversationId } from "../contract.js";
import type { ReplyGrant } from "../harness-runtime.js";
import type {
  Begin,
  BeginDigest,
  CertifiedRecord,
  ClientRepresentationError,
  MulticastAction,
  VerifiedMembership,
} from "./representation.js";
import type {
  EngineAttentionError,
  EngineProspectiveTurn,
  EngineReplyError,
} from "./engine-types.js";
import type {
  RouterIngressDisposition,
  RouterWorkerIngress,
  RouterWorkerPersistenceError,
} from "./router-worker.js";
import type { EndpointStore } from "./store.js";

/** One newly durable head supplied only by ordinary live protocol delivery. */
export interface OpenFloorCertifiedHead {
  readonly conversationId: ConversationId;
  readonly membership: VerifiedMembership;
  readonly currentAnchorHash: MulticastAction["anchorHash"];
  readonly recordHash: MulticastAction["previousRecordHash"];
  readonly record: CertifiedRecord;
}

/** Task-validated MULTICAST ready for the engine's certification fold. */
export interface OpenFloorMulticastCandidate {
  readonly conversationId: ConversationId;
  readonly beginDigest: BeginDigest;
  readonly membership: VerifiedMembership;
  readonly action: MulticastAction;
  readonly localActionSignature: SignedMessage;
}

/** Engine-owned effects around the task layer's volatile fold. */
export interface OpenFloorActions {
  readonly queueBegin: (
    membership: VerifiedMembership,
    begin: Begin,
  ) => Effect.Effect<void, ClientRepresentationError>;
  readonly queueEvidence: (
    membership: VerifiedMembership,
    evidence: SignedMessage,
  ) => Effect.Effect<void, ClientRepresentationError>;
  readonly onMulticastCandidate: (
    candidate: OpenFloorMulticastCandidate,
  ) => Effect.Effect<void, ClientRepresentationError>;
  readonly deliverTurn: (
    turn: EngineProspectiveTurn,
  ) => Effect.Effect<void, RouterWorkerPersistenceError>;
}

/** Private construction input for one endpoint's OpenFloorV1 fold. */
export interface OpenFloorInput {
  readonly localAgentCard: VerifiedAgentCard;
  readonly signingAuthority: AgentSigningAuthority;
  readonly store: Pick<EndpointStore, "hasConsumedAttention">;
  readonly actions: OpenFloorActions;
  readonly randomBytes?: (size: number) => Uint8Array;
}

/** Volatile task capability composed inside one endpoint engine. */
export interface OpenFloorPort {
  readonly listenerAttached: Effect.Effect<void, EngineAttentionError>;
  readonly listenerDetached: Effect.Effect<void>;
  readonly certifiedHead: (
    head: OpenFloorCertifiedHead,
  ) => Effect.Effect<void, EngineAttentionError>;
  readonly acceptIngress: (
    ingress: RouterWorkerIngress<
      import("./representation.js").DecodedOuterBody
    >,
  ) => Effect.Effect<RouterIngressDisposition, RouterWorkerPersistenceError>;
  readonly admitReply: (
    grant: ReplyGrant,
    content: Content,
  ) => Effect.Effect<OpenFloorMulticastCandidate, EngineReplyError>;
  readonly abandon: Effect.Effect<void>;
}
