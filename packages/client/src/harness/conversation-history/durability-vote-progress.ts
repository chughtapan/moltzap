/**
 * @file Accumulates verified durability signers for one record against one
 * immutable conversation-membership snapshot.
 */

import type { AgentId } from "@moltzap/identity";
import { Data, Either } from "effect";

import {
  durabilityQuorum,
  type DurabilityQuorum,
  type InvalidMembershipSizeError,
  meetsDurabilityThreshold,
} from "./durability-quorum.js";

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

/** Immutable verified-signer state for one action-certified record. */
export interface DurabilityVoteProgress<RecordHash> {
  /** Stable hash of the exact staged action-certified record. */
  readonly recordHash: RecordHash;
  /** Membership captured when collection begins. */
  readonly memberAgentIds: ReadonlySet<AgentId>;
  /** Distinct verified fixed members accumulated for this record. */
  readonly signerAgentIds: ReadonlySet<AgentId>;
  /** Threshold derived once from the captured membership. */
  readonly quorum: DurabilityQuorum;
}

/** Closed meanings for one successful signer merge. */
export const durabilityVoteDisposition = {
  duplicate: "duplicate",
  collecting: "collecting",
  completed: "completed",
  enriched: "enriched",
} as const;

/** Meaning of one successful signer merge. */
export type DurabilityVoteDisposition =
  (typeof durabilityVoteDisposition)[keyof typeof durabilityVoteDisposition];

/** Immutable result of merging one already-verified signer identity. */
export interface DurabilityVoteMerge<RecordHash> {
  readonly progress: DurabilityVoteProgress<RecordHash>;
  readonly disposition: DurabilityVoteDisposition;
  readonly newlyCompleted: boolean;
}

/** Private inputs used after the exact record has been durably staged. */
interface DurabilityVoteProgressInput<RecordHash> {
  readonly recordHash: RecordHash;
  readonly memberAgentIds: ReadonlySet<AgentId>;
}

/** One vote whose signature and signed fields have already been verified. */
interface VerifiedDurabilityVote<RecordHash> {
  readonly recordHash: RecordHash;
  readonly signerAgentId: AgentId;
}

/** Private merge inputs that leave hash representation with the caller. */
interface DurabilityVoteMergeInput<RecordHash> {
  readonly progress: DurabilityVoteProgress<RecordHash>;
  readonly vote: VerifiedDurabilityVote<RecordHash>;
  readonly sameRecordHash: (left: RecordHash, right: RecordHash) => boolean;
}

/**
 * Starts vote collection for one staged record and fixed membership.
 *
 * @param input Stable record identity and complete conversation membership.
 * @returns Empty signer progress or the quorum's invalid-membership failure.
 */
export const makeDurabilityVoteProgress = <RecordHash>(
  input: DurabilityVoteProgressInput<RecordHash>,
): Either.Either<
  DurabilityVoteProgress<RecordHash>,
  InvalidMembershipSizeError
> => {
  const membershipSnapshot = new Set(input.memberAgentIds);

  return Either.map(durabilityQuorum(membershipSnapshot.size), (quorum) => ({
    recordHash: input.recordHash,
    memberAgentIds: membershipSnapshot,
    signerAgentIds: new Set<AgentId>(),
    quorum,
  }));
};

const successfulMerge = <RecordHash>(
  progress: DurabilityVoteProgress<RecordHash>,
  disposition: DurabilityVoteDisposition,
  newlyCompleted: boolean,
): Either.Either<DurabilityVoteMerge<RecordHash>> =>
  Either.right({ progress, disposition, newlyCompleted });

/**
 * Merges one vote after its signature and record binding are verified.
 *
 * @param input Current progress, verified vote, and trusted hash equality.
 * @returns Updated progress and the exact threshold-transition disposition.
 */
export const mergeVerifiedDurabilityVote = <RecordHash>(
  input: DurabilityVoteMergeInput<RecordHash>,
): Either.Either<
  DurabilityVoteMerge<RecordHash>,
  DurabilityRecordMismatchError<RecordHash> | NonMemberDurabilitySignerError
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

  if (progress.signerAgentIds.has(vote.signerAgentId)) {
    return successfulMerge(
      progress,
      durabilityVoteDisposition.duplicate,
      false,
    );
  }

  return mergeNewSigner(progress, vote.signerAgentId);
};

function mergeNewSigner<RecordHash>(
  progress: DurabilityVoteProgress<RecordHash>,
  signerAgentId: AgentId,
): Either.Either<DurabilityVoteMerge<RecordHash>> {
  const wasComplete = meetsDurabilityThreshold(
    progress.quorum,
    progress.signerAgentIds.size,
  );
  const signerAgentIds = new Set(progress.signerAgentIds);
  signerAgentIds.add(signerAgentId);
  const nextProgress = { ...progress, signerAgentIds };
  const newlyCompleted =
    !wasComplete &&
    meetsDurabilityThreshold(progress.quorum, signerAgentIds.size);

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
