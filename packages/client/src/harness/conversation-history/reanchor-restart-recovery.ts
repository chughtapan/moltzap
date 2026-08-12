/**
 * @file Classifies durable Router re-anchor state after restart without
 * repeating a completed local promotion or weakening quorum requirements.
 */

import { Data, Either } from "effect";

import type { StagedReanchorCandidate } from "./reanchor-candidate-slot.js";
import {
  planReanchorAdvance,
  type ReanchorAdvance,
  type ReanchorAdvanceInput,
  StagedReanchorVoteMismatchError,
} from "./reanchor-advance.js";

/** The staged candidate does not extend the endpoint's durable current anchor. */
export class ReanchorPredecessorMismatchError<BodyHash> extends Data.TaggedError(
  "ReanchorPredecessorMismatchError",
)<{
  readonly currentAnchorBodyHash: BodyHash;
  readonly stagedAnchorBodyHash: BodyHash;
}> {}

/** A staged anchor whose verified evidence remains below its fixed threshold. */
interface RecoveredReanchorCollection<BodyHash> {
  readonly _tag: "collecting";
  readonly bodyHash: BodyHash;
  readonly signerCount: number;
  readonly requiredVotes: number;
}

/** A quorum-complete staged anchor ready for one atomic local promotion. */
interface RecoveredReanchorPromotion<Domain, BodyHash, VoteEvidence> {
  readonly _tag: "promotion";
  readonly advance: ReanchorAdvance<Domain, BodyHash, VoteEvidence>;
}

/** The staged anchor is already the endpoint's durable current anchor. */
interface RecoveredCurrentReanchor<BodyHash> {
  readonly _tag: "current";
  readonly bodyHash: BodyHash;
}

/** Closed restart outcomes for one recovered staged Router re-anchor. */
type ReanchorRestartRecovery<Domain, BodyHash, VoteEvidence> =
  | RecoveredCurrentReanchor<BodyHash>
  | RecoveredReanchorCollection<BodyHash>
  | RecoveredReanchorPromotion<Domain, BodyHash, VoteEvidence>;

interface ReanchorRestartRecoveryInput<Domain, BodyHash, VoteEvidence>
  extends ReanchorAdvanceInput<Domain, BodyHash, VoteEvidence> {
  readonly currentAnchor: StagedReanchorCandidate<Domain, BodyHash>;
  readonly stagedExtendsCurrentAnchor: (
    currentAnchor: StagedReanchorCandidate<Domain, BodyHash>,
    staged: StagedReanchorCandidate<Domain, BodyHash>,
  ) => boolean;
}

type ReanchorRestartRecoveryError<BodyHash> =
  | ReanchorPredecessorMismatchError<BodyHash>
  | StagedReanchorVoteMismatchError<BodyHash>;

/**
 * Plans the next recovery action from one already-verified durable snapshot.
 *
 * An anchor below threshold resumes collection, a complete successor is
 * eligible for atomic promotion, and an anchor already named by durable
 * current state remains current. The predecessor callback verifies the
 * representation-owned Router-epoch binding without choosing its shape here.
 *
 * @param input Current and staged anchors, verified votes, and trusted checks.
 * @returns One closed recovery action or a fail-closed consistency error.
 */
export const planReanchorRestartRecovery = <
  Domain,
  BodyHash,
  VoteEvidence,
>(
  input: ReanchorRestartRecoveryInput<Domain, BodyHash, VoteEvidence>,
): Either.Either<
  ReanchorRestartRecovery<Domain, BodyHash, VoteEvidence>,
  ReanchorRestartRecoveryError<BodyHash>
> => {
  if (!input.sameBodyHash(input.staged.bodyHash, input.voteProgress.bodyHash)) {
    return Either.left(
      new StagedReanchorVoteMismatchError({
        stagedBodyHash: input.staged.bodyHash,
        voteBodyHash: input.voteProgress.bodyHash,
      }),
    );
  }

  if (
    input.sameBodyHash(
      input.currentAnchor.bodyHash,
      input.staged.bodyHash,
    )
  ) {
    return Either.right(
      Object.freeze({
        _tag: "current" as const,
        bodyHash: input.currentAnchor.bodyHash,
      }),
    );
  }

  if (!input.stagedExtendsCurrentAnchor(input.currentAnchor, input.staged)) {
    return Either.left(
      new ReanchorPredecessorMismatchError({
        currentAnchorBodyHash: input.currentAnchor.bodyHash,
        stagedAnchorBodyHash: input.staged.bodyHash,
      }),
    );
  }

  return classifyPendingRecovery(input);
};

function classifyPendingRecovery<Domain, BodyHash, VoteEvidence>(
  input: ReanchorRestartRecoveryInput<Domain, BodyHash, VoteEvidence>,
): Either.Either<
  | RecoveredReanchorCollection<BodyHash>
  | RecoveredReanchorPromotion<Domain, BodyHash, VoteEvidence>,
  StagedReanchorVoteMismatchError<BodyHash>
> {
  return Either.match(planReanchorAdvance(input), {
    onLeft: (error) =>
      error._tag === "IncompleteReanchorEvidenceError"
        ? Either.right(
            Object.freeze({
              _tag: "collecting" as const,
              bodyHash: input.staged.bodyHash,
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
