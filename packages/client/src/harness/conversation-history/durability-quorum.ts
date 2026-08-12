/**
 * @file Computes fixed-membership durability thresholds and their minimum
 * honest staged-replica guarantees behind the private harness boundary.
 */

import { Data, Either } from "effect";

/** A membership count cannot define the fixed-membership durability profile. */
export class InvalidMembershipSizeError extends Data.TaggedError(
  "InvalidMembershipSizeError",
)<{
  readonly memberCount: number;
}> {}

/** Closed arithmetic shared by durability voting and Router re-anchoring. */
export interface DurabilityQuorum {
  /** Fixed members participating in the conversation. */
  readonly memberCount: number;
  /** Maximum Byzantine members covered by the replicated-storage guarantee. */
  readonly byzantineBound: number;
  /** Distinct valid member votes required for completion. */
  readonly requiredVotes: number;
  /**
   * Honest staged replicas guaranteed when the stated Byzantine bound holds
   * and honest members durably stage the exact record before signing.
   */
  readonly honestStagedReplicaFloor: number;
}

/**
 * Computes the durability profile for one fixed membership.
 *
 * @param memberCount Positive safe-integer membership size.
 * @returns The closed quorum arithmetic or a typed invalid-size failure.
 */
export const durabilityQuorum = (
  memberCount: number,
): Either.Either<DurabilityQuorum, InvalidMembershipSizeError> => {
  if (!Number.isSafeInteger(memberCount) || memberCount < 1) {
    return Either.left(new InvalidMembershipSizeError({ memberCount }));
  }

  const byzantineBound =
    memberCount < 4 ? 0 : Math.floor((memberCount - 1) / 3);
  const requiredVotes =
    memberCount < 4 ? memberCount : memberCount - byzantineBound;

  return Either.right({
    memberCount,
    byzantineBound,
    requiredVotes,
    honestStagedReplicaFloor: requiredVotes - byzantineBound,
  });
};

/**
 * Tests a distinct verified member-vote count against one computed profile.
 * Signer identity and signature validation happen before this arithmetic seam.
 *
 * @param quorum Fixed-membership durability profile.
 * @param distinctVerifiedMemberVotes Count after member and duplicate checks.
 * @returns Whether the threshold is complete.
 */
export const meetsDurabilityThreshold = (
  quorum: DurabilityQuorum,
  distinctVerifiedMemberVotes: number,
): boolean =>
  Number.isSafeInteger(distinctVerifiedMemberVotes) &&
  distinctVerifiedMemberVotes >= quorum.requiredVotes &&
  distinctVerifiedMemberVotes <= quorum.memberCount;
