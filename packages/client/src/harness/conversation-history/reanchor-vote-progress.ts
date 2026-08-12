/**
 * @file Accumulates verified Router re-anchor signers for one stable anchor
 * body against one immutable conversation-membership snapshot.
 */

import type { AgentId } from "@moltzap/identity";
import { Data, Either } from "effect";

import {
  durabilityQuorum,
  type DurabilityQuorum,
  type InvalidMembershipSizeError,
  meetsDurabilityThreshold,
} from "./durability-quorum.js";

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

/** Immutable verified-signer state for one staged re-anchor body. */
export interface ReanchorVoteProgress<BodyHash> {
  /** Stable hash binding the selected head and Router-epoch transition. */
  readonly bodyHash: BodyHash;
  /** Membership captured when collection begins. */
  readonly memberAgentIds: ReadonlySet<AgentId>;
  /** Distinct verified fixed members accumulated for this anchor. */
  readonly signerAgentIds: ReadonlySet<AgentId>;
  /** Threshold shared with durability voting. */
  readonly quorum: DurabilityQuorum;
}

/** Closed meanings for one successful re-anchor signer merge. */
export const reanchorVoteDisposition = {
  duplicate: "duplicate",
  collecting: "collecting",
  completed: "completed",
  enriched: "enriched",
} as const;

/** Meaning of one successful re-anchor signer merge. */
type ReanchorVoteDisposition =
  (typeof reanchorVoteDisposition)[keyof typeof reanchorVoteDisposition];

/** Immutable result of merging one already-verified re-anchor vote. */
export interface ReanchorVoteMerge<BodyHash> {
  readonly progress: ReanchorVoteProgress<BodyHash>;
  readonly disposition: ReanchorVoteDisposition;
  readonly newlyCompleted: boolean;
}

/** Private inputs used after the staged anchor body has been verified. */
interface ReanchorVoteProgressInput<BodyHash> {
  readonly bodyHash: BodyHash;
  readonly memberAgentIds: ReadonlySet<AgentId>;
}

/** One vote whose signature and signed fields have already been verified. */
interface VerifiedReanchorVote<BodyHash> {
  readonly bodyHash: BodyHash;
  readonly signerAgentId: AgentId;
}

/** Private merge inputs that leave hash representation with the caller. */
interface ReanchorVoteMergeInput<BodyHash> {
  readonly progress: ReanchorVoteProgress<BodyHash>;
  readonly vote: VerifiedReanchorVote<BodyHash>;
  readonly sameBodyHash: (left: BodyHash, right: BodyHash) => boolean;
}

/**
 * Starts re-anchor vote collection from one staged body and fixed membership.
 *
 * @param input Staged body identity and complete fixed membership.
 * @returns Empty signer progress or the quorum's invalid-membership failure.
 */
export const makeReanchorVoteProgress = <BodyHash>(
  input: ReanchorVoteProgressInput<BodyHash>,
): Either.Either<
  ReanchorVoteProgress<BodyHash>,
  InvalidMembershipSizeError
> => {
  const membershipSnapshot = new Set(input.memberAgentIds);

  return Either.map(durabilityQuorum(membershipSnapshot.size), (quorum) => ({
    bodyHash: input.bodyHash,
    memberAgentIds: membershipSnapshot,
    signerAgentIds: new Set<AgentId>(),
    quorum,
  }));
};

/**
 * Merges one vote after its signature and anchor-body fields are verified.
 *
 * A vote for another body fails instead of entering this signer's map. Hash
 * equality remains caller-supplied so this private state selects no concrete
 * anchor-hash representation.
 *
 * @param input Current progress, verified vote, and trusted hash equality.
 * @returns Updated immutable progress or a closed binding/member failure.
 */
export const mergeVerifiedReanchorVote = <BodyHash>(
  input: ReanchorVoteMergeInput<BodyHash>,
): Either.Either<
  ReanchorVoteMerge<BodyHash>,
  ReanchorBodyMismatchError<BodyHash> | NonMemberReanchorSignerError
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
  if (progress.signerAgentIds.has(vote.signerAgentId)) {
    return successfulMerge(progress, reanchorVoteDisposition.duplicate, false);
  }

  return mergeNewSigner(progress, vote.signerAgentId);
};

function mergeNewSigner<BodyHash>(
  progress: ReanchorVoteProgress<BodyHash>,
  signerAgentId: AgentId,
): Either.Either<ReanchorVoteMerge<BodyHash>> {
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

function successfulMerge<BodyHash>(
  progress: ReanchorVoteProgress<BodyHash>,
  disposition: ReanchorVoteDisposition,
  newlyCompleted: boolean,
): Either.Either<ReanchorVoteMerge<BodyHash>> {
  return Either.right({ progress, disposition, newlyCompleted });
}
