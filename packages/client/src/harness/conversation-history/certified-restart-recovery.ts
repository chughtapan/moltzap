/**
 * @file Classifies durable action-record state after restart without treating
 * partial evidence as history or repeating a completed local promotion.
 */

import { Either } from "effect";

import {
  type CertifiedHeadAdvance,
  type CertifiedHeadAdvanceInput,
  type CertifiedPredecessorMismatchError,
  planCertifiedHeadAdvance,
  StagedRecordVoteMismatchError,
} from "./certified-head-advance.js";

/** A staged record whose verified evidence remains below its fixed threshold. */
interface RecoveredDurabilityCollection<RecordHash> {
  readonly _tag: "collecting";
  readonly recordHash: RecordHash;
  readonly signerCount: number;
  readonly requiredVotes: number;
}

/** A quorum-complete staged record ready for one atomic local promotion. */
interface RecoveredCertifiedPromotion<
  RecordHash,
  Record,
  VoteEvidence,
> {
  readonly _tag: "promotion";
  readonly advance: CertifiedHeadAdvance<RecordHash, Record, VoteEvidence>;
}

/** A complete record already present at the endpoint's durable head. */
interface RecoveredCertifiedRecord<RecordHash> {
  readonly _tag: "certified";
  readonly recordHash: RecordHash;
}

/** Closed restart outcomes for one recovered staged action record. */
type CertifiedRestartRecovery<RecordHash, Record, VoteEvidence> =
  | RecoveredDurabilityCollection<RecordHash>
  | RecoveredCertifiedPromotion<RecordHash, Record, VoteEvidence>
  | RecoveredCertifiedRecord<RecordHash>;

type CertifiedRestartRecoveryInput<RecordHash, Record, VoteEvidence> =
  CertifiedHeadAdvanceInput<RecordHash, Record, VoteEvidence>;

type CertifiedRestartRecoveryError<RecordHash> =
  | CertifiedPredecessorMismatchError<RecordHash>
  | StagedRecordVoteMismatchError<RecordHash>;

/**
 * Plans the next recovery action from one already-verified durable snapshot.
 *
 * A record below threshold resumes collection, a complete child is eligible
 * for atomic promotion, and a record already named by the verified durable
 * head remains certified. No outcome creates runtime attention or advances
 * the head by itself.
 *
 * @param input Durable head, staged record, verified votes, and hash equality.
 * @returns One closed recovery action or a fail-closed consistency error.
 */
export const planCertifiedRestartRecovery = <
  RecordHash,
  Record,
  VoteEvidence,
>(
  input: CertifiedRestartRecoveryInput<RecordHash, Record, VoteEvidence>,
): Either.Either<
  CertifiedRestartRecovery<RecordHash, Record, VoteEvidence>,
  CertifiedRestartRecoveryError<RecordHash>
> => {
  if (
    !input.sameRecordHash(input.staged.recordHash, input.voteProgress.recordHash)
  ) {
    return Either.left(
      new StagedRecordVoteMismatchError({
        stagedRecordHash: input.staged.recordHash,
        voteRecordHash: input.voteProgress.recordHash,
      }),
    );
  }

  if (
    input.currentHead._tag === "certified" &&
    input.sameRecordHash(
      input.currentHead.recordHash,
      input.staged.recordHash,
    )
  ) {
    return Either.right(
      Object.freeze({
        _tag: "certified" as const,
        recordHash: input.currentHead.recordHash,
      }),
    );
  }

  return classifyPendingRecovery(input);
};

function classifyPendingRecovery<RecordHash, Record, VoteEvidence>(
  input: CertifiedRestartRecoveryInput<RecordHash, Record, VoteEvidence>,
): Either.Either<
  | RecoveredCertifiedPromotion<RecordHash, Record, VoteEvidence>
  | RecoveredDurabilityCollection<RecordHash>,
  | CertifiedPredecessorMismatchError<RecordHash>
  | StagedRecordVoteMismatchError<RecordHash>
> {
  return Either.match(planCertifiedHeadAdvance(input), {
    onLeft: (error) =>
      error._tag === "IncompleteDurabilityEvidenceError"
        ? Either.right(
            Object.freeze({
              _tag: "collecting" as const,
              recordHash: input.staged.recordHash,
              signerCount: error.signerCount,
              requiredVotes: error.requiredVotes,
            }),
          )
        : Either.left(error),
    onRight: (advance) =>
      Either.right(
        Object.freeze({
          _tag: "promotion" as const,
          advance,
        }),
      ),
  });
}
