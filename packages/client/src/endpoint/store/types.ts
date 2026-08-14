/** @file Private typed contract for endpoint persistence operations. */

import type { Effect } from "effect";
import type { EndpointStoreError } from "./database/index.js";

/** Whether an idempotent mutation inserted state or observed the same state. */
export type StoreMutation = "inserted" | "existing";

/** Canonical bytes bound to the one local identity. */
export interface IdentityBinding {
  readonly agentId: string;
  readonly canonicalAgentCard: Uint8Array;
}

/** Caller-owned START identity and its exact canonical intent. */
export interface StartIntent {
  readonly conversationId: string;
  readonly canonicalIntent: Uint8Array;
  readonly completedRecordHash?: string;
}

/** Immutable membership and genesis Router anchor for one START intent. */
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

/** One exact action-certified record staged before a durability vote. */
export interface StagedRecord {
  readonly conversationId: string;
  readonly recordHash: string;
  readonly previousRecordHash?: string;
  readonly membershipHash: string;
  readonly anchorHash: string;
  readonly canonicalRecord: Uint8Array;
}

/** One complete certified representation of a staged record. */
export interface CertifiedRecord extends StagedRecord {
  readonly canonicalCertifiedRecord: Uint8Array;
}

/** Mergeable protocol evidence addressed by its stable private identity. */
export interface ProtocolEvidence {
  readonly conversationId: string;
  readonly kind: "action" | "durability" | "catch-up" | "reanchor";
  readonly subjectId: string;
  readonly evidenceKey: string;
  readonly canonicalEvidence: Uint8Array;
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
  readonly startIntents: readonly StartIntent[];
  readonly memberships: readonly StoredMembership[];
  readonly anchors: readonly StoredAnchor[];
  readonly positions: readonly ConversationPosition[];
  readonly stagedRecords: readonly StagedRecord[];
  readonly evidence: readonly ProtocolEvidence[];
  readonly certifiedRecords: readonly CertifiedRecord[];
  readonly stagedReanchors: readonly RecoveredReanchor[];
  readonly consumedAttention: ReadonlyArray<
    Readonly<{
      conversationId: string;
      recordHash: string;
    }>
  >;
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
  readonly bindStartIntent: (
    intent: StartIntent,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly putConversationFoundation: (
    foundation: ConversationFoundation,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly stageRecord: (
    record: StagedRecord,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly mergeEvidence: (
    evidence: ProtocolEvidence,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly promoteRecord: (
    record: CertifiedRecord,
  ) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly applyCatchUpRecord: (
    record: CertifiedRecord,
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
  readonly consumeAttention: (input: {
    readonly conversationId: string;
    readonly recordHash: string;
  }) => Effect.Effect<StoreMutation, EndpointStoreError>;
  readonly hasConsumedAttention: (input: {
    readonly conversationId: string;
    readonly recordHash: string;
  }) => Effect.Effect<boolean, EndpointStoreError>;
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
