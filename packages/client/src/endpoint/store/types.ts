/** @file Private typed contract for endpoint persistence operations. */

import { type Effect, Either, Encoding, Schema } from "effect";
import type { EndpointStoreError } from "./database/values.js";

/* eslint-disable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- The private Effect Schema and decoded nominal value intentionally share one domain name. */

/** Stable opaque identity for one durable inbound delivery. */
export const DeliveryToken = Schema.String.pipe(
  Schema.filter((value) => {
    if (!value.startsWith("dlv_")) {
      return false;
    }
    const suffix = value.slice(4);
    return Either.match(Encoding.decodeBase64Url(suffix), {
      onLeft: () => false,
      onRight: (bytes) =>
        bytes.length === 32 && Encoding.encodeBase64Url(bytes) === suffix,
    });
  }),
  Schema.brand("DeliveryToken"),
);

/** Strictly decoded private durable delivery identity. */
export type DeliveryToken = typeof DeliveryToken.Type;

/* eslint-enable @typescript-eslint/naming-convention, @typescript-eslint/no-redeclare -- Restore defaults after the private Schema/type pair. */

/** Whether an idempotent mutation inserted state or observed the same state. */
export type StoreMutation = "inserted" | "existing";

/** Canonical bytes bound to the one local identity. */
export interface IdentityBinding {
  readonly agentId: string;
  readonly canonicalAgentCard: Uint8Array;
}

/** One locally authored immutable post intent and its completion. */
export interface PostIntent {
  readonly conversationId: string;
  readonly membershipHash: string;
  readonly authorAgentId: string;
  readonly postId: string;
  readonly canonicalIntent: Uint8Array;
  readonly completedRecordHash?: string;
}

/** Atomic binding for a post in either retained or newly founded history. */
export type PostIntentBinding =
  | Readonly<{
      kind: "existing-conversation";
      intent: PostIntent;
    }>
  | Readonly<{
      kind: "new-conversation";
      foundation: ConversationFoundation;
      intent: PostIntent;
    }>;

/** Immutable membership and genesis Router anchor for one conversation. */
export interface ConversationFoundation {
  readonly conversationId: string;
  readonly membershipHash: string;
  readonly canonicalMembership: Uint8Array;
  readonly anchorHash: string;
  readonly canonicalAnchor: Uint8Array;
}

/** One immutable membership descriptor recovered independently of anchors. */
export interface StoredMembership {
  readonly conversationId: string;
  readonly membershipHash: string;
  readonly canonicalMembership: Uint8Array;
}

/** One genesis or completed Router-epoch anchor in the retained chain. */
export interface StoredAnchor {
  readonly conversationId: string;
  readonly anchorHash: string;
  readonly previousAnchorHash?: string;
  readonly selectedRecordHash?: string;
  readonly canonicalAnchor: Uint8Array;
}

/** The first Router-ordered action selected for one predecessor. */
export interface ProposalLock {
  readonly conversationId: string;
  readonly previousRecordHash?: string;
  readonly actionHash: string;
  readonly canonicalActionCore: Uint8Array;
}

/** One exact record core staged before a durability vote. */
export interface StagedRecord {
  readonly conversationId: string;
  readonly recordHash: string;
  readonly previousRecordHash?: string;
  readonly membershipHash: string;
  readonly anchorHash: string;
  readonly actionHash: string;
  readonly authorAgentId: string;
  readonly postId: string;
  readonly canonicalRecordCore: Uint8Array;
}

/** Mergeable protocol evidence addressed by its stable private identity. */
export interface ProtocolEvidence {
  readonly conversationId: string;
  readonly kind: "action" | "durability" | "catch-up" | "reanchor";
  readonly subjectId: string;
  readonly evidenceKey: string;
  readonly canonicalEvidence: Uint8Array;
}

/** One certified record with action and durability evidence kept separate. */
export interface CertifiedRecord extends StagedRecord {
  readonly actionEvidence: readonly ProtocolEvidence[];
  readonly durabilityEvidence: readonly ProtocolEvidence[];
}

/** Canonical host message inserted when a remote record becomes certified. */
export interface InboundDeliveryInput {
  readonly recipientAgentId: string;
  readonly canonicalMessage: Uint8Array;
}

/** One stable durable host-delivery row, including its retained tombstone. */
export interface PendingDelivery extends InboundDeliveryInput {
  readonly deliveryToken: DeliveryToken;
  readonly conversationId: string;
  readonly recordHash: string;
  readonly acknowledged: boolean;
}

/** Canonical complete outer message before it receives a stable outbox key. */
export interface OutboundMessageInput {
  readonly conversationId: string;
  readonly messageId: string;
  readonly canonicalSignedMessage: Uint8Array;
}

/** Current complete outer envelope retained under its initial message identity. */
export interface StoredOutboundMessage extends OutboundMessageInput {
  readonly outboundId: string;
}

/** Closed packet family whose durable state requires later dissemination. */
export type DisseminationKind = "action-certified-record" | "certified-record";

/** Durable logical packet that has not yet been attached to an outbox row. */
export interface DisseminationObligation {
  readonly conversationId: string;
  readonly recordHash: string;
  readonly kind: DisseminationKind;
}

/** Durable disposition chosen immediately before one Router attempt. */
export type OutboundAttempt =
  | Readonly<{ kind: "inactive" }>
  | Readonly<{
      kind: "pending";
      mode: "initial" | "retry";
      outbound: StoredOutboundMessage;
    }>;

/** Exact empty-history Router-anchor replacement guarded by the old foundation. */
export interface EmptyConversationRestart {
  readonly expectedFoundation: ConversationFoundation;
  readonly replacementFoundation: ConversationFoundation;
}

/** Durable state retained after an empty conversation changes Router instance. */
export interface RestartedEmptyConversation {
  readonly foundation: ConversationFoundation;
  readonly postIntents: readonly PostIntent[];
}

/** One staged Router-epoch proposal. */
export interface StagedReanchor {
  readonly conversationId: string;
  readonly anchorHash: string;
  readonly previousAnchorHash: string;
  readonly routerInstanceId: string;
  readonly selectedRecordHash: string;
  readonly canonicalBody: Uint8Array;
}

/** One completed Router-epoch proposal and its threshold evidence. */
export interface CompletedReanchor extends StagedReanchor {
  readonly canonicalCompletedReanchor: Uint8Array;
}

/** One recoverable re-anchor candidate, complete only when evidence is present. */
export interface RecoveredReanchor extends StagedReanchor {
  readonly canonicalCompletedReanchor?: Uint8Array;
}

/** One durable current position for a conversation. */
export interface ConversationPosition {
  readonly conversationId: string;
  readonly membershipHash: string;
  readonly currentAnchorHash: string;
  readonly headRecordHash?: string;
}

/** Complete private state recovered after opening the endpoint database. */
export interface EndpointRecovery {
  readonly identity?: IdentityBinding;
  readonly postIntents: readonly PostIntent[];
  readonly memberships: readonly StoredMembership[];
  readonly anchors: readonly StoredAnchor[];
  readonly positions: readonly ConversationPosition[];
  readonly proposalLocks: readonly ProposalLock[];
  readonly stagedRecords: readonly StagedRecord[];
  readonly evidence: readonly ProtocolEvidence[];
  readonly certifiedRecords: readonly CertifiedRecord[];
  readonly stagedReanchors: readonly RecoveredReanchor[];
  readonly pendingDeliveries: readonly PendingDelivery[];
  readonly disseminationObligations: readonly DisseminationObligation[];
  readonly outboundMessages: readonly StoredOutboundMessage[];
}

/** One management page over local conversation identifiers. */
export interface ConversationPage {
  readonly conversationIds: readonly string[];
  readonly hasMore: boolean;
}

/** One frozen management page of complete certified records. */
export interface HistoryPage {
  readonly records: readonly CertifiedRecord[];
  readonly continuation: string | null;
}

/** Private durable operations owned by one daemon process. */
export interface EndpointStore {
  readonly readIdentity: () => Effect.Effect<
    IdentityBinding | undefined,
    EndpointStoreError
  >;
  readonly bindIdentity: (
    binding: IdentityBinding,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly bindPostIntent: (
    binding: PostIntentBinding,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly putConversationFoundation: (
    foundation: ConversationFoundation,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly lockProposal: (
    proposal: ProposalLock,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly lockGenesisProposal: (
    foundation: ConversationFoundation,
    proposal: ProposalLock,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly stageRecord: (
    record: StagedRecord,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly stageRecordForDissemination: (
    record: StagedRecord,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly mergeEvidence: (
    evidence: ProtocolEvidence,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly promoteRecord: (
    record: CertifiedRecord,
    delivery?: InboundDeliveryInput,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly promoteRecordForDissemination: (
    record: CertifiedRecord,
    delivery?: InboundDeliveryInput,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly applyCatchUpRecord: (
    record: CertifiedRecord,
    delivery?: InboundDeliveryInput,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly stageReanchor: (
    reanchor: StagedReanchor,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly completeReanchor: (
    reanchor: CompletedReanchor,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly applyCatchUpReanchor: (
    reanchor: CompletedReanchor,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly readPendingDeliveries: () => Effect.Effect<
    readonly PendingDelivery[],
    EndpointStoreError
  >;
  readonly acknowledgeDelivery: (
    deliveryToken: DeliveryToken,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly enqueueOutbound: (
    message: OutboundMessageInput,
  ) => Effect.Effect<StoredOutboundMessage, EndpointStoreError>;
  readonly enqueueDisseminationOutbound: (
    obligation: DisseminationObligation,
    message: OutboundMessageInput,
  ) => Effect.Effect<StoredOutboundMessage, EndpointStoreError>;
  readonly beginOutbound: (
    outboundId: string,
  ) => Effect.Effect<OutboundAttempt, EndpointStoreError>;
  readonly replaceOutbound: (
    current: StoredOutboundMessage,
    replacement: OutboundMessageInput,
  ) => Effect.Effect<StoredOutboundMessage, EndpointStoreError>;
  readonly completeOutbound: (
    outbound: StoredOutboundMessage,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly discardOutbound: (
    outbounds: readonly StoredOutboundMessage[],
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly restartEmptyConversation: (
    restart: EmptyConversationRestart,
  ) => Effect.Effect<RestartedEmptyConversation, EndpointStoreError>;
  readonly searchConversations: (input?: {
    readonly afterConversationId?: string;
  }) => Effect.Effect<ConversationPage, EndpointStoreError>;
  readonly readConversation: (
    request:
      | Readonly<{
          conversationId: string;
          afterRecordHash?: string;
        }>
      | Readonly<{ continuation: string }>,
  ) => Effect.Effect<HistoryPage, EndpointStoreError>;
  readonly releaseContinuation: (
    continuation: string,
  ) => Effect.Effect<void, EndpointStoreError>;
  readonly recover: () => Effect.Effect<EndpointRecovery, EndpointStoreError>;
}
