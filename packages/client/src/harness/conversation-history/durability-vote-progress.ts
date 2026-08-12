/**
 * @file Accumulates complete verified durability-vote evidence for one record
 * against one immutable conversation-membership snapshot.
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

/** One verified signer does not belong to the record's fixed membership. */
export class NonMemberDurabilitySignerError extends Data.TaggedError(
  "NonMemberDurabilitySignerError",
)<{
  readonly signerAgentId: AgentId;
}> {}

/** A verified vote names a different action-certified record. */
export class DurabilityRecordMismatchError<RecordHash> extends Data.TaggedError(
  "DurabilityRecordMismatchError",
)<{
  readonly expectedRecordHash: RecordHash;
  readonly receivedRecordHash: RecordHash;
}> {}

/** One signer supplied different evidence after its first verified vote. */
export class ConflictingDurabilityVoteEvidenceError<
  VoteEvidence,
> extends Data.TaggedError("ConflictingDurabilityVoteEvidenceError")<{
  readonly signerAgentId: AgentId;
  readonly existingEvidence: VoteEvidence;
  readonly receivedEvidence: VoteEvidence;
}> {}

/** Immutable verified-vote state for one action-certified record. */
export interface DurabilityVoteProgress<RecordHash, VoteEvidence> {
  /** Stable hash of the exact staged action-certified record. */
  readonly recordHash: RecordHash;
  /** Membership captured when collection begins. */
  readonly memberAgentIds: ReadonlySet<AgentId>;
  /** Complete verified vote evidence keyed by its fixed-member signer. */
  readonly voteEvidenceBySigner: ReadonlyMap<AgentId, VoteEvidence>;
  /** Threshold derived once from the captured membership. */
  readonly quorum: DurabilityQuorum;
}

/** Closed meanings for one successful vote merge. */
export const durabilityVoteDisposition = {
  duplicate: "duplicate",
  collecting: "collecting",
  completed: "completed",
  enriched: "enriched",
} as const;

/** Meaning of one successful vote merge. */
export type DurabilityVoteDisposition =
  (typeof durabilityVoteDisposition)[keyof typeof durabilityVoteDisposition];

/** Immutable result of merging one already-verified vote. */
export interface DurabilityVoteMerge<RecordHash, VoteEvidence> {
  readonly progress: DurabilityVoteProgress<RecordHash, VoteEvidence>;
  readonly disposition: DurabilityVoteDisposition;
  readonly newlyCompleted: boolean;
}

/** Private inputs used after the exact record has been durably staged. */
interface DurabilityVoteProgressInput<RecordHash> {
  readonly recordHash: RecordHash;
  readonly memberAgentIds: ReadonlySet<AgentId>;
}

/** One vote whose signature and signed fields have already been verified. */
interface VerifiedDurabilityVote<RecordHash, VoteEvidence> {
  readonly recordHash: RecordHash;
  readonly signerAgentId: AgentId;
  readonly evidence: VoteEvidence;
}

/** Private merge inputs that leave hash and evidence equality with the caller. */
interface DurabilityVoteMergeInput<RecordHash, VoteEvidence> {
  readonly progress: DurabilityVoteProgress<RecordHash, VoteEvidence>;
  readonly vote: VerifiedDurabilityVote<RecordHash, VoteEvidence>;
  readonly sameRecordHash: (left: RecordHash, right: RecordHash) => boolean;
  readonly sameVoteEvidence: (
    left: VoteEvidence,
    right: VoteEvidence,
  ) => boolean;
}

/**
 * Starts vote collection for one staged record and fixed membership.
 *
 * @param input Stable record identity and complete conversation membership.
 * @returns Empty vote progress or the quorum's invalid-membership failure.
 */
export const makeDurabilityVoteProgress = <RecordHash, VoteEvidence>(
  input: DurabilityVoteProgressInput<RecordHash>,
): Either.Either<
  DurabilityVoteProgress<RecordHash, VoteEvidence>,
  InvalidMembershipSizeError
> => {
  const membershipSnapshot = readonlySetSnapshot(input.memberAgentIds);

  return Either.map(durabilityQuorum(membershipSnapshot.size), (quorum) =>
    Object.freeze({
      recordHash: input.recordHash,
      memberAgentIds: membershipSnapshot,
      voteEvidenceBySigner: readonlyMapSnapshot(
        new Map<AgentId, VoteEvidence>(),
      ),
      quorum,
    }),
  );
};

const successfulMerge = <RecordHash, VoteEvidence>(
  progress: DurabilityVoteProgress<RecordHash, VoteEvidence>,
  disposition: DurabilityVoteDisposition,
  newlyCompleted: boolean,
): Either.Either<DurabilityVoteMerge<RecordHash, VoteEvidence>> =>
  Either.right({ progress, disposition, newlyCompleted });

/**
 * Merges one vote after its signature and record binding are verified.
 *
 * @param input Current progress, verified vote, and trusted equalities.
 * @returns Updated progress and the exact threshold-transition disposition.
 */
export const mergeVerifiedDurabilityVote = <RecordHash, VoteEvidence>(
  input: DurabilityVoteMergeInput<RecordHash, VoteEvidence>,
): Either.Either<
  DurabilityVoteMerge<RecordHash, VoteEvidence>,
  | ConflictingDurabilityVoteEvidenceError<VoteEvidence>
  | DurabilityRecordMismatchError<RecordHash>
  | NonMemberDurabilitySignerError
> => {
  const { progress, vote } = input;
  if (!input.sameRecordHash(progress.recordHash, vote.recordHash)) {
    return Either.left(
      new DurabilityRecordMismatchError({
        expectedRecordHash: progress.recordHash,
        receivedRecordHash: vote.recordHash,
      }),
    );
  }
  if (!progress.memberAgentIds.has(vote.signerAgentId)) {
    return Either.left(
      new NonMemberDurabilitySignerError({
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
        new ConflictingDurabilityVoteEvidenceError({
          signerAgentId: vote.signerAgentId,
          existingEvidence,
          receivedEvidence: vote.evidence,
        }),
      );
    }
    return successfulMerge(
      progress,
      durabilityVoteDisposition.duplicate,
      false,
    );
  }

  return mergeNewVote(progress, vote.signerAgentId, vote.evidence);
};

function mergeNewVote<RecordHash, VoteEvidence>(
  progress: DurabilityVoteProgress<RecordHash, VoteEvidence>,
  signerAgentId: AgentId,
  evidence: VoteEvidence,
): Either.Either<DurabilityVoteMerge<RecordHash, VoteEvidence>> {
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
      durabilityVoteDisposition.completed,
      true,
    );
  }
  return successfulMerge(
    nextProgress,
    wasComplete
      ? durabilityVoteDisposition.enriched
      : durabilityVoteDisposition.collecting,
    false,
  );
}
