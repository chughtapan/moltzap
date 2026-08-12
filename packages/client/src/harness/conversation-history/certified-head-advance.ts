/**
 * @file Plans a certified-history head advance only after the staged record,
 * predecessor, and verified durability-vote progress agree.
 */

import type { AgentId } from "@moltzap/identity";
import { Data, Either } from "effect";

import { meetsDurabilityThreshold } from "./durability-quorum.js";
import {
  ConflictingDurabilityVoteEvidenceError,
  type DurabilityVoteProgress,
  NonMemberDurabilitySignerError,
} from "./durability-vote-progress.js";
import { readonlyMapSnapshot } from "./immutable-collections.js";

/** One endpoint's current durable certified-history position. */
export type CertifiedHistoryHead<RecordHash> =
  | Readonly<{ readonly _tag: "empty" }>
  | Readonly<{
      readonly _tag: "certified";
      readonly recordHash: RecordHash;
    }>;

/** One already-verified action-certified record in durable staged state. */
export interface StagedActionCertifiedRecord<RecordHash, Record> {
  readonly recordHash: RecordHash;
  readonly previousRecordHash: RecordHash | null;
  readonly record: Record;
}

/** Vote progress belongs to another staged action-certified record. */
export class StagedRecordVoteMismatchError<RecordHash> extends Data.TaggedError(
  "StagedRecordVoteMismatchError",
)<{
  readonly stagedRecordHash: RecordHash;
  readonly voteRecordHash: RecordHash;
}> {}

/** The staged record does not extend the endpoint's current certified head. */
export class CertifiedPredecessorMismatchError<
  RecordHash,
> extends Data.TaggedError("CertifiedPredecessorMismatchError")<{
  readonly expectedPreviousRecordHash: RecordHash | null;
  readonly receivedPreviousRecordHash: RecordHash | null;
}> {}

/** Verified durability votes have not reached the fixed threshold. */
export class IncompleteDurabilityEvidenceError extends Data.TaggedError(
  "IncompleteDurabilityEvidenceError",
)<{
  readonly signerCount: number;
  readonly requiredVotes: number;
}> {}

/** Incoming evidence belongs to a different certified history position. */
export class CertifiedEvidenceRecordMismatchError<
  RecordHash,
> extends Data.TaggedError("CertifiedEvidenceRecordMismatchError")<{
  readonly existingRecordHash: RecordHash;
  readonly receivedRecordHash: RecordHash;
}> {}

/** Incoming evidence was collected against another membership snapshot. */
export class CertifiedEvidenceMembershipMismatchError extends Data.TaggedError(
  "CertifiedEvidenceMembershipMismatchError",
)<{
  readonly existingMemberCount: number;
  readonly receivedMemberCount: number;
}> {}

/** The stored evidence does not establish that the record is certified. */
export class ExistingCertifiedEvidenceIncompleteError extends Data.TaggedError(
  "ExistingCertifiedEvidenceIncompleteError",
)<{
  readonly signerCount: number;
  readonly requiredVotes: number;
}> {}

/** A transition the endpoint store may commit atomically with its record. */
export interface CertifiedHeadAdvance<RecordHash, Record, VoteEvidence> {
  readonly staged: StagedActionCertifiedRecord<RecordHash, Record>;
  /** Independent snapshot of every complete verified durability vote. */
  readonly durabilityEvidenceBySigner: ReadonlyMap<AgentId, VoteEvidence>;
  readonly nextHead: CertifiedHistoryHead<RecordHash>;
}

/** Evidence-only update for an existing certified history position. */
export interface CertifiedEvidenceEnrichment<RecordHash, VoteEvidence> {
  readonly recordHash: RecordHash;
  readonly durabilityEvidenceBySigner: ReadonlyMap<AgentId, VoteEvidence>;
  readonly disposition: "unchanged" | "enriched";
}

/** Private inputs loaded from one endpoint-store transaction. */
interface CertifiedHeadAdvanceInput<RecordHash, Record, VoteEvidence> {
  readonly currentHead: CertifiedHistoryHead<RecordHash>;
  readonly staged: StagedActionCertifiedRecord<RecordHash, Record>;
  readonly voteProgress: DurabilityVoteProgress<RecordHash, VoteEvidence>;
  readonly sameRecordHash: (left: RecordHash, right: RecordHash) => boolean;
}

/** Private inputs whose evidence has already passed signature verification. */
interface CertifiedEvidenceEnrichmentInput<RecordHash, VoteEvidence> {
  readonly existingProgress: DurabilityVoteProgress<RecordHash, VoteEvidence>;
  readonly receivedProgress: DurabilityVoteProgress<RecordHash, VoteEvidence>;
  readonly sameRecordHash: (left: RecordHash, right: RecordHash) => boolean;
  readonly sameVoteEvidence: (
    left: VoteEvidence,
    right: VoteEvidence,
  ) => boolean;
}

type CertifiedEvidenceEnrichmentError<RecordHash, VoteEvidence> =
  | CertifiedEvidenceMembershipMismatchError
  | CertifiedEvidenceRecordMismatchError<RecordHash>
  | ConflictingDurabilityVoteEvidenceError<VoteEvidence>
  | ExistingCertifiedEvidenceIncompleteError
  | NonMemberDurabilitySignerError;

/**
 * Checks whether one staged record may advance the durable certified head.
 *
 * This function plans no mutation by itself. The caller commits the staged
 * record, complete verified evidence, and returned head in one durable store
 * transaction. A mismatch or incomplete threshold leaves the current head
 * unchanged.
 *
 * @param input Current head, staged record, verified votes, and hash equality.
 * @returns An immutable advance plan or a closed fail-closed reason.
 */
export const planCertifiedHeadAdvance = <RecordHash, Record, VoteEvidence>(
  input: CertifiedHeadAdvanceInput<RecordHash, Record, VoteEvidence>,
): Either.Either<
  CertifiedHeadAdvance<RecordHash, Record, VoteEvidence>,
  | CertifiedPredecessorMismatchError<RecordHash>
  | IncompleteDurabilityEvidenceError
  | StagedRecordVoteMismatchError<RecordHash>
> => {
  const recordMismatch = findRecordMismatch(input);
  if (recordMismatch !== null) {
    return Either.left(recordMismatch);
  }

  const predecessorMismatch = findPredecessorMismatch(input);
  if (predecessorMismatch !== null) {
    return Either.left(predecessorMismatch);
  }

  const incompleteEvidence = findIncompleteEvidence(input.voteProgress);
  if (incompleteEvidence !== null) {
    return Either.left(incompleteEvidence);
  }

  return Either.right({
    staged: snapshotStagedRecord(input.staged),
    durabilityEvidenceBySigner: readonlyMapSnapshot(
      input.voteProgress.voteEvidenceBySigner,
    ),
    nextHead: Object.freeze({
      _tag: "certified" as const,
      recordHash: input.staged.recordHash,
    }),
  });
};

/**
 * Merges verified votes into one already certified record without producing a
 * history transition. The caller persists the returned map at the same record
 * hash; the plan carries no head, action, or runtime-attention authority.
 *
 * @param input Existing certified evidence and verified votes for enrichment.
 * @returns An immutable evidence-only plan or a closed consistency failure.
 */
export const planCertifiedEvidenceEnrichment = <RecordHash, VoteEvidence>(
  input: CertifiedEvidenceEnrichmentInput<RecordHash, VoteEvidence>,
): Either.Either<
  CertifiedEvidenceEnrichment<RecordHash, VoteEvidence>,
  CertifiedEvidenceEnrichmentError<RecordHash, VoteEvidence>
> => {
  const recordMismatch = findCertifiedEvidenceRecordMismatch(input);
  if (recordMismatch !== null) {
    return Either.left(recordMismatch);
  }

  if (!sameMembership(input.existingProgress, input.receivedProgress)) {
    return Either.left(
      new CertifiedEvidenceMembershipMismatchError({
        existingMemberCount: input.existingProgress.memberAgentIds.size,
        receivedMemberCount: input.receivedProgress.memberAgentIds.size,
      }),
    );
  }

  return Either.flatMap(
    validateExistingCertifiedEvidence(input),
    (mergedEvidence) => mergeReceivedCertifiedEvidence(input, mergedEvidence),
  );
};

function findRecordMismatch<RecordHash, Record, VoteEvidence>(
  input: CertifiedHeadAdvanceInput<RecordHash, Record, VoteEvidence>,
): StagedRecordVoteMismatchError<RecordHash> | null {
  if (
    input.sameRecordHash(input.staged.recordHash, input.voteProgress.recordHash)
  ) {
    return null;
  }
  return new StagedRecordVoteMismatchError({
    stagedRecordHash: input.staged.recordHash,
    voteRecordHash: input.voteProgress.recordHash,
  });
}

function findPredecessorMismatch<RecordHash, Record, VoteEvidence>(
  input: CertifiedHeadAdvanceInput<RecordHash, Record, VoteEvidence>,
): CertifiedPredecessorMismatchError<RecordHash> | null {
  const expectedPreviousRecordHash = previousHashFor(input.currentHead);
  if (
    sameOptionalHash(
      expectedPreviousRecordHash,
      input.staged.previousRecordHash,
      input.sameRecordHash,
    )
  ) {
    return null;
  }
  return new CertifiedPredecessorMismatchError({
    expectedPreviousRecordHash,
    receivedPreviousRecordHash: input.staged.previousRecordHash,
  });
}

function findIncompleteEvidence<RecordHash, VoteEvidence>(
  progress: DurabilityVoteProgress<RecordHash, VoteEvidence>,
): IncompleteDurabilityEvidenceError | null {
  if (
    meetsDurabilityThreshold(
      progress.quorum,
      progress.voteEvidenceBySigner.size,
    )
  ) {
    return null;
  }
  return new IncompleteDurabilityEvidenceError({
    signerCount: progress.voteEvidenceBySigner.size,
    requiredVotes: progress.quorum.requiredVotes,
  });
}

function previousHashFor<RecordHash>(
  head: CertifiedHistoryHead<RecordHash>,
): RecordHash | null {
  return head._tag === "empty" ? null : head.recordHash;
}

function sameOptionalHash<RecordHash>(
  left: RecordHash | null,
  right: RecordHash | null,
  sameRecordHash: (left: RecordHash, right: RecordHash) => boolean,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return sameRecordHash(left, right);
}

function snapshotStagedRecord<RecordHash, Record>(
  staged: StagedActionCertifiedRecord<RecordHash, Record>,
): StagedActionCertifiedRecord<RecordHash, Record> {
  return Object.freeze({ ...staged });
}

function findCertifiedEvidenceRecordMismatch<RecordHash, VoteEvidence>(
  input: CertifiedEvidenceEnrichmentInput<RecordHash, VoteEvidence>,
): CertifiedEvidenceRecordMismatchError<RecordHash> | null {
  if (
    input.sameRecordHash(
      input.existingProgress.recordHash,
      input.receivedProgress.recordHash,
    )
  ) {
    return null;
  }
  return new CertifiedEvidenceRecordMismatchError({
    existingRecordHash: input.existingProgress.recordHash,
    receivedRecordHash: input.receivedProgress.recordHash,
  });
}

function sameMembership<RecordHash, VoteEvidence>(
  existing: DurabilityVoteProgress<RecordHash, VoteEvidence>,
  received: DurabilityVoteProgress<RecordHash, VoteEvidence>,
): boolean {
  if (existing.memberAgentIds.size !== received.memberAgentIds.size) {
    return false;
  }
  for (const memberAgentId of existing.memberAgentIds) {
    if (!received.memberAgentIds.has(memberAgentId)) {
      return false;
    }
  }
  return true;
}

function validateExistingCertifiedEvidence<RecordHash, VoteEvidence>(
  input: CertifiedEvidenceEnrichmentInput<RecordHash, VoteEvidence>,
): Either.Either<
  Map<AgentId, VoteEvidence>,
  ExistingCertifiedEvidenceIncompleteError | NonMemberDurabilitySignerError
> {
  for (const signerAgentId of input.existingProgress.voteEvidenceBySigner.keys()) {
    if (!input.existingProgress.memberAgentIds.has(signerAgentId)) {
      return Either.left(new NonMemberDurabilitySignerError({ signerAgentId }));
    }
  }
  if (
    meetsDurabilityThreshold(
      input.existingProgress.quorum,
      input.existingProgress.voteEvidenceBySigner.size,
    )
  ) {
    return Either.right(new Map(input.existingProgress.voteEvidenceBySigner));
  }
  return Either.left(
    new ExistingCertifiedEvidenceIncompleteError({
      signerCount: input.existingProgress.voteEvidenceBySigner.size,
      requiredVotes: input.existingProgress.quorum.requiredVotes,
    }),
  );
}

function mergeReceivedCertifiedEvidence<RecordHash, VoteEvidence>(
  input: CertifiedEvidenceEnrichmentInput<RecordHash, VoteEvidence>,
  mergedEvidence: Map<AgentId, VoteEvidence>,
): Either.Either<
  CertifiedEvidenceEnrichment<RecordHash, VoteEvidence>,
  | ConflictingDurabilityVoteEvidenceError<VoteEvidence>
  | NonMemberDurabilitySignerError
> {
  for (const entry of input.receivedProgress.voteEvidenceBySigner) {
    const mergeError = mergeOneCertifiedEvidence(input, mergedEvidence, entry);
    if (mergeError !== null) {
      return Either.left(mergeError);
    }
  }
  return Either.right(makeCertifiedEvidenceEnrichment(input, mergedEvidence));
}

function mergeOneCertifiedEvidence<RecordHash, VoteEvidence>(
  input: CertifiedEvidenceEnrichmentInput<RecordHash, VoteEvidence>,
  mergedEvidence: Map<AgentId, VoteEvidence>,
  entry: readonly [AgentId, VoteEvidence],
):
  | ConflictingDurabilityVoteEvidenceError<VoteEvidence>
  | NonMemberDurabilitySignerError
  | null {
  const [signerAgentId, receivedEvidence] = entry;
  if (!input.receivedProgress.memberAgentIds.has(signerAgentId)) {
    return new NonMemberDurabilitySignerError({ signerAgentId });
  }
  if (mergedEvidence.has(signerAgentId)) {
    const existingEvidence =
      /* Safe because Map.has distinguishes stored evidence from an absent signer, including when VoteEvidence is undefined. */ mergedEvidence.get(
        signerAgentId,
      ) as VoteEvidence;
    if (!input.sameVoteEvidence(existingEvidence, receivedEvidence)) {
      return new ConflictingDurabilityVoteEvidenceError({
        signerAgentId,
        existingEvidence,
        receivedEvidence,
      });
    }
  }
  mergedEvidence.set(signerAgentId, receivedEvidence);
  return null;
}

function makeCertifiedEvidenceEnrichment<RecordHash, VoteEvidence>(
  input: CertifiedEvidenceEnrichmentInput<RecordHash, VoteEvidence>,
  mergedEvidence: ReadonlyMap<AgentId, VoteEvidence>,
): CertifiedEvidenceEnrichment<RecordHash, VoteEvidence> {
  return Object.freeze({
    recordHash: input.existingProgress.recordHash,
    durabilityEvidenceBySigner: readonlyMapSnapshot(mergedEvidence),
    disposition:
      mergedEvidence.size === input.existingProgress.voteEvidenceBySigner.size
        ? ("unchanged" as const)
        : ("enriched" as const),
  });
}
