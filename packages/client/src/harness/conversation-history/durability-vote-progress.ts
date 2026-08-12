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

/** Immutable verified-signer state for one action-certified record. */
export interface DurabilityVoteProgress {
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
export interface DurabilityVoteMerge {
  readonly progress: DurabilityVoteProgress;
  readonly disposition: DurabilityVoteDisposition;
  readonly newlyCompleted: boolean;
}

/**
 * Starts signer collection from a fixed membership snapshot.
 *
 * @param memberAgentIds Complete conversation membership for this record.
 * @returns Empty signer progress or the quorum's invalid-membership failure.
 */
export const makeDurabilityVoteProgress = (
  memberAgentIds: ReadonlySet<AgentId>,
): Either.Either<DurabilityVoteProgress, InvalidMembershipSizeError> => {
  const membershipSnapshot = new Set(memberAgentIds);

  return Either.map(durabilityQuorum(membershipSnapshot.size), (quorum) => ({
    memberAgentIds: membershipSnapshot,
    signerAgentIds: new Set<AgentId>(),
    quorum,
  }));
};

const successfulMerge = (
  progress: DurabilityVoteProgress,
  disposition: DurabilityVoteDisposition,
  newlyCompleted: boolean,
): Either.Either<DurabilityVoteMerge> =>
  Either.right({ progress, disposition, newlyCompleted });

/**
 * Merges one signer after its vote signature and record binding are verified.
 *
 * @param progress Current immutable signer state for one record.
 * @param signerAgentId Identity from the already-verified vote.
 * @returns Updated progress and the exact threshold-transition disposition.
 */
export const mergeVerifiedDurabilitySigner = (
  progress: DurabilityVoteProgress,
  signerAgentId: AgentId,
): Either.Either<DurabilityVoteMerge, NonMemberDurabilitySignerError> => {
  if (!progress.memberAgentIds.has(signerAgentId)) {
    return Either.left(new NonMemberDurabilitySignerError({ signerAgentId }));
  }

  if (progress.signerAgentIds.has(signerAgentId)) {
    return successfulMerge(
      progress,
      durabilityVoteDisposition.duplicate,
      false,
    );
  }

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
};
