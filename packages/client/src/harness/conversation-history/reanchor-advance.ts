/**
 * @file Plans one Router re-anchor to become locally current only after its
 * staged body and complete verified vote evidence agree.
 */

import type { AgentId } from "@moltzap/identity";
import { Data, Either } from "effect";

import type { StagedReanchorCandidate } from "./reanchor-candidate-slot.js";
import type { ReanchorVoteProgress } from "./reanchor-vote-progress.js";
import { meetsDurabilityThreshold } from "./durability-quorum.js";
import { readonlyMapSnapshot } from "./immutable-collections.js";

/** Vote progress belongs to another staged re-anchor body. */
export class StagedReanchorVoteMismatchError<BodyHash> extends Data.TaggedError(
  "StagedReanchorVoteMismatchError",
)<{
  readonly stagedBodyHash: BodyHash;
  readonly voteBodyHash: BodyHash;
}> {}

/** Verified re-anchor votes have not reached the fixed threshold. */
export class IncompleteReanchorEvidenceError extends Data.TaggedError(
  "IncompleteReanchorEvidenceError",
)<{
  readonly signerCount: number;
  readonly requiredVotes: number;
}> {}

/** A transition the endpoint store may commit as its current Router anchor. */
export interface ReanchorAdvance<Domain, BodyHash, VoteEvidence> {
  /** Staged candidate to make current when the plan is durably committed. */
  readonly currentAnchor: StagedReanchorCandidate<Domain, BodyHash>;
  /** Independent snapshot of every complete verified re-anchor vote. */
  readonly reanchorEvidenceBySigner: ReadonlyMap<AgentId, VoteEvidence>;
}

/** Private inputs loaded from one endpoint-store transaction. */
export interface ReanchorAdvanceInput<Domain, BodyHash, VoteEvidence> {
  readonly staged: StagedReanchorCandidate<Domain, BodyHash>;
  readonly voteProgress: ReanchorVoteProgress<BodyHash, VoteEvidence>;
  readonly sameBodyHash: (left: BodyHash, right: BodyHash) => boolean;
}

/**
 * Checks whether one staged re-anchor may become locally current.
 *
 * This function plans no mutation by itself. The caller commits the anchor
 * and complete verified evidence in one durable transaction. A mismatch or
 * incomplete threshold leaves the preceding anchor current.
 *
 * @param input Staged candidate, verified votes, and trusted hash equality.
 * @returns An immutable current-anchor plan or a closed fail-closed reason.
 */
export const planReanchorAdvance = <Domain, BodyHash, VoteEvidence>(
  input: ReanchorAdvanceInput<Domain, BodyHash, VoteEvidence>,
): Either.Either<
  ReanchorAdvance<Domain, BodyHash, VoteEvidence>,
  IncompleteReanchorEvidenceError | StagedReanchorVoteMismatchError<BodyHash>
> => {
  if (!input.sameBodyHash(input.staged.bodyHash, input.voteProgress.bodyHash)) {
    return Either.left(
      new StagedReanchorVoteMismatchError({
        stagedBodyHash: input.staged.bodyHash,
        voteBodyHash: input.voteProgress.bodyHash,
      }),
    );
  }

  const signerCount = input.voteProgress.voteEvidenceBySigner.size;
  if (!meetsDurabilityThreshold(input.voteProgress.quorum, signerCount)) {
    return Either.left(
      new IncompleteReanchorEvidenceError({
        signerCount,
        requiredVotes: input.voteProgress.quorum.requiredVotes,
      }),
    );
  }

  return Either.right({
    currentAnchor: Object.freeze({ ...input.staged }),
    reanchorEvidenceBySigner: readonlyMapSnapshot(
      input.voteProgress.voteEvidenceBySigner,
    ),
  });
};
