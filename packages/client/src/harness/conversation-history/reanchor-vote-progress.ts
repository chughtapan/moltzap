/**
 * @file Accumulates complete verified Router re-anchor vote evidence for one
 * stable body against one immutable conversation-membership snapshot.
 */

import type { AgentId } from "@moltzap/identity";
import { Data, Either } from "effect";

import {
  durabilityQuorum,
  type DurabilityQuorum,
  type InvalidMembershipSizeError,
  meetsDurabilityThreshold,
} from "./durability-quorum.js";
import {
  readonlyMapSnapshot,
  readonlySetSnapshot,
} from "./immutable-collections.js";

/** One verified re-anchor signer is outside the fixed membership. */
export class NonMemberReanchorSignerError extends Data.TaggedError(
  "NonMemberReanchorSignerError",
)<{
  readonly signerAgentId: AgentId;
}> {}

/** A verified vote names a different stable re-anchor body. */
export class ReanchorBodyMismatchError<BodyHash> extends Data.TaggedError(
  "ReanchorBodyMismatchError",
)<{
  readonly expectedBodyHash: BodyHash;
  readonly receivedBodyHash: BodyHash;
}> {}

/** One signer supplied different evidence after its first verified vote. */
export class ConflictingReanchorVoteEvidenceError<
  VoteEvidence,
> extends Data.TaggedError("ConflictingReanchorVoteEvidenceError")<{
  readonly signerAgentId: AgentId;
  readonly existingEvidence: VoteEvidence;
  readonly receivedEvidence: VoteEvidence;
}> {}

/** Immutable verified-vote state for one staged re-anchor body. */
export interface ReanchorVoteProgress<BodyHash, VoteEvidence> {
  /** Stable hash binding the selected head and Router-epoch transition. */
  readonly bodyHash: BodyHash;
  /** Membership captured when collection begins. */
  readonly memberAgentIds: ReadonlySet<AgentId>;
  /** Complete verified vote evidence keyed by its fixed-member signer. */
  readonly voteEvidenceBySigner: ReadonlyMap<AgentId, VoteEvidence>;
  /** Threshold shared with durability voting. */
  readonly quorum: DurabilityQuorum;
}

/** Closed meanings for one successful re-anchor vote merge. */
export const reanchorVoteDisposition = {
  duplicate: "duplicate",
  collecting: "collecting",
  completed: "completed",
  enriched: "enriched",
} as const;

/** Meaning of one successful re-anchor vote merge. */
type ReanchorVoteDisposition =
  (typeof reanchorVoteDisposition)[keyof typeof reanchorVoteDisposition];

/** Immutable result of merging one already-verified re-anchor vote. */
export interface ReanchorVoteMerge<BodyHash, VoteEvidence> {
  readonly progress: ReanchorVoteProgress<BodyHash, VoteEvidence>;
  readonly disposition: ReanchorVoteDisposition;
  readonly newlyCompleted: boolean;
}

/** Private inputs used after the staged anchor body has been verified. */
interface ReanchorVoteProgressInput<BodyHash> {
  readonly bodyHash: BodyHash;
  readonly memberAgentIds: ReadonlySet<AgentId>;
}

/** One vote whose signature and signed fields have already been verified. */
interface VerifiedReanchorVote<BodyHash, VoteEvidence> {
  readonly bodyHash: BodyHash;
  readonly signerAgentId: AgentId;
  readonly evidence: VoteEvidence;
}

/** Private merge inputs that leave hash and evidence equality with the caller. */
interface ReanchorVoteMergeInput<BodyHash, VoteEvidence> {
  readonly progress: ReanchorVoteProgress<BodyHash, VoteEvidence>;
  readonly vote: VerifiedReanchorVote<BodyHash, VoteEvidence>;
  readonly sameBodyHash: (left: BodyHash, right: BodyHash) => boolean;
  readonly sameVoteEvidence: (
    left: VoteEvidence,
    right: VoteEvidence,
  ) => boolean;
}

/**
 * Starts re-anchor vote collection from one staged body and fixed membership.
 *
 * @param input Staged body identity and complete fixed membership.
 * @returns Empty vote progress or the quorum's invalid-membership failure.
 */
export const makeReanchorVoteProgress = <BodyHash, VoteEvidence>(
  input: ReanchorVoteProgressInput<BodyHash>,
): Either.Either<
  ReanchorVoteProgress<BodyHash, VoteEvidence>,
  InvalidMembershipSizeError
> => {
  const membershipSnapshot = readonlySetSnapshot(input.memberAgentIds);

  return Either.map(durabilityQuorum(membershipSnapshot.size), (quorum) =>
    Object.freeze({
      bodyHash: input.bodyHash,
      memberAgentIds: membershipSnapshot,
      voteEvidenceBySigner: readonlyMapSnapshot(
        new Map<AgentId, VoteEvidence>(),
      ),
      quorum,
    }),
  );
};

/**
 * Merges one vote after its signature and anchor-body fields are verified.
 *
 * A vote for another body fails before its signer or evidence is inspected.
 * Hash and evidence equality remain caller-supplied so this private state
 * selects no concrete anchor or vote representation.
 *
 * @param input Current progress, verified vote, and trusted equalities.
 * @returns Updated immutable progress or a closed binding/member failure.
 */
export const mergeVerifiedReanchorVote = <BodyHash, VoteEvidence>(
  input: ReanchorVoteMergeInput<BodyHash, VoteEvidence>,
): Either.Either<
  ReanchorVoteMerge<BodyHash, VoteEvidence>,
  | ConflictingReanchorVoteEvidenceError<VoteEvidence>
  | NonMemberReanchorSignerError
  | ReanchorBodyMismatchError<BodyHash>
> => {
  const { progress, vote } = input;
  if (!input.sameBodyHash(progress.bodyHash, vote.bodyHash)) {
    return Either.left(
      new ReanchorBodyMismatchError({
        expectedBodyHash: progress.bodyHash,
        receivedBodyHash: vote.bodyHash,
      }),
    );
  }
  if (!progress.memberAgentIds.has(vote.signerAgentId)) {
    return Either.left(
      new NonMemberReanchorSignerError({
        signerAgentId: vote.signerAgentId,
      }),
    );
  }
  if (progress.voteEvidenceBySigner.has(vote.signerAgentId)) {
    const existingEvidence =
      /* Safe because the preceding presence check distinguishes stored evidence from an absent signer. */ progress.voteEvidenceBySigner.get(
        vote.signerAgentId,
      ) as VoteEvidence;
    if (!input.sameVoteEvidence(existingEvidence, vote.evidence)) {
      return Either.left(
        new ConflictingReanchorVoteEvidenceError({
          signerAgentId: vote.signerAgentId,
          existingEvidence,
          receivedEvidence: vote.evidence,
        }),
      );
    }
    return successfulMerge(progress, reanchorVoteDisposition.duplicate, false);
  }

  return mergeNewVote(progress, vote.signerAgentId, vote.evidence);
};

function mergeNewVote<BodyHash, VoteEvidence>(
  progress: ReanchorVoteProgress<BodyHash, VoteEvidence>,
  signerAgentId: AgentId,
  evidence: VoteEvidence,
): Either.Either<ReanchorVoteMerge<BodyHash, VoteEvidence>> {
  const wasComplete = meetsDurabilityThreshold(
    progress.quorum,
    progress.voteEvidenceBySigner.size,
  );
  const evidenceSnapshot = new Map(progress.voteEvidenceBySigner);
  evidenceSnapshot.set(signerAgentId, evidence);
  const voteEvidenceBySigner = readonlyMapSnapshot(evidenceSnapshot);
  const nextProgress = Object.freeze({ ...progress, voteEvidenceBySigner });
  const newlyCompleted =
    !wasComplete &&
    meetsDurabilityThreshold(progress.quorum, voteEvidenceBySigner.size);

  if (newlyCompleted) {
    return successfulMerge(
      nextProgress,
      reanchorVoteDisposition.completed,
      true,
    );
  }
  return successfulMerge(
    nextProgress,
    wasComplete
      ? reanchorVoteDisposition.enriched
      : reanchorVoteDisposition.collecting,
    false,
  );
}

function successfulMerge<BodyHash, VoteEvidence>(
  progress: ReanchorVoteProgress<BodyHash, VoteEvidence>,
  disposition: ReanchorVoteDisposition,
  newlyCompleted: boolean,
): Either.Either<ReanchorVoteMerge<BodyHash, VoteEvidence>> {
  return Either.right({ progress, disposition, newlyCompleted });
}
