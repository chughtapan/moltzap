/**
 * @file Plans a certified-history head advance only after the staged record,
 * predecessor, and verified durability-vote progress agree.
 */

import type { AgentId } from "@moltzap/identity";
import { Data, Either } from "effect";

import type { DurabilityVoteProgress } from "./durability-vote-progress.js";
import { meetsDurabilityThreshold } from "./durability-quorum.js";
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

/** A transition the endpoint store may commit atomically with its record. */
export interface CertifiedHeadAdvance<RecordHash, Record, VoteEvidence> {
  readonly staged: StagedActionCertifiedRecord<RecordHash, Record>;
  /** Independent snapshot of every complete verified durability vote. */
  readonly durabilityEvidenceBySigner: ReadonlyMap<AgentId, VoteEvidence>;
  readonly nextHead: CertifiedHistoryHead<RecordHash>;
}

/** Private inputs loaded from one endpoint-store transaction. */
interface CertifiedHeadAdvanceInput<RecordHash, Record, VoteEvidence> {
  readonly currentHead: CertifiedHistoryHead<RecordHash>;
  readonly staged: StagedActionCertifiedRecord<RecordHash, Record>;
  readonly voteProgress: DurabilityVoteProgress<RecordHash, VoteEvidence>;
  readonly sameRecordHash: (left: RecordHash, right: RecordHash) => boolean;
}

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
