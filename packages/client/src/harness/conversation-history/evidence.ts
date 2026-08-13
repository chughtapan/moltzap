/**
 * @file Collects verified fixed-member evidence for private conversation
 * actions, durable records, and Router re-anchors.
 */

import type { AgentId } from "@moltzap/identity";
import { Data, Either } from "effect";

import {
  durabilityQuorum,
  type InvalidMembershipSizeError,
} from "./durability-quorum.js";

/** Whether completion needs every member or the durability threshold. */
export type EvidenceRequirement = "all-members" | "durability-quorum";

/** One verified item retained with the member that supplied it. */
export interface SignerEvidence<Evidence> {
  readonly signerAgentId: AgentId;
  readonly evidence: Evidence;
}

/** Verified evidence collected for one subject and fixed membership. */
export interface EvidenceProgress<Subject, Evidence> {
  readonly subject: Subject;
  readonly memberAgentIds: readonly AgentId[];
  readonly requiredSigners: number;
  readonly evidenceBySigner: ReadonlyArray<SignerEvidence<Evidence>>;
}

/** An independent snapshot whose evidence satisfies its fixed requirement. */
export interface CompleteEvidence<Subject, Evidence>
  extends EvidenceProgress<Subject, Evidence> {}

/** One verified item names a different subject. */
export class EvidenceSubjectMismatchError<Subject> extends Data.TaggedError(
  "EvidenceSubjectMismatchError",
)<{
  readonly expectedSubject: Subject;
  readonly receivedSubject: Subject;
}> {}

/** A verified signer is outside the captured membership. */
export class NonMemberEvidenceSignerError extends Data.TaggedError(
  "NonMemberEvidenceSignerError",
)<{
  readonly signerAgentId: AgentId;
}> {}

/** One signer supplied different evidence after its first verified item. */
export class ConflictingSignerEvidenceError<Evidence> extends Data.TaggedError(
  "ConflictingSignerEvidenceError",
)<{
  readonly signerAgentId: AgentId;
  readonly existingEvidence: Evidence;
  readonly receivedEvidence: Evidence;
}> {}

/** Closed meanings for one successful evidence merge. */
export type EvidenceDisposition =
  | "duplicate"
  | "collecting"
  | "completed"
  | "enriched";

/** Result of merging one already-verified item. */
export interface EvidenceMerge<Subject, Evidence> {
  readonly progress: EvidenceProgress<Subject, Evidence>;
  readonly disposition: EvidenceDisposition;
  readonly newlyCompleted: boolean;
  readonly completion: CompleteEvidence<Subject, Evidence> | null;
}

interface EvidenceProgressInput<Subject> {
  readonly subject: Subject;
  readonly memberAgentIds: ReadonlySet<AgentId>;
  readonly requirement: EvidenceRequirement;
}

interface VerifiedEvidence<Subject, Evidence> {
  readonly subject: Subject;
  readonly signerAgentId: AgentId;
  readonly evidence: Evidence;
}

interface EvidenceMergeInput<Subject, Evidence> {
  readonly progress: EvidenceProgress<Subject, Evidence>;
  readonly received: VerifiedEvidence<Subject, Evidence>;
  readonly sameSubject: (left: Subject, right: Subject) => boolean;
  readonly sameEvidence: (left: Evidence, right: Evidence) => boolean;
}

/**
 * Starts one evidence collection against a detached membership snapshot.
 *
 * @param input Subject, fixed membership, and its completion requirement.
 * @returns Empty progress or the shared invalid-membership failure.
 */
export const makeEvidenceProgress = <Subject, Evidence>(
  input: EvidenceProgressInput<Subject>,
): Either.Either<
  EvidenceProgress<Subject, Evidence>,
  InvalidMembershipSizeError
> =>
  Either.map(durabilityQuorum(input.memberAgentIds.size), (quorum) =>
    Object.freeze({
      subject: input.subject,
      memberAgentIds: Object.freeze([...input.memberAgentIds]),
      requiredSigners:
        input.requirement === "all-members"
          ? quorum.memberCount
          : quorum.requiredVotes,
      evidenceBySigner: Object.freeze([]),
    }),
  );

/**
 * Merges one verified item without retaining mutable caller collections.
 *
 * @param input Current progress, verified item, and trusted equalities.
 * @returns Updated progress or one closed binding/member failure.
 */
/**
 * Tests whether collected distinct-member evidence meets its requirement.
 *
 * @param progress Fixed-member evidence collected for one subject.
 * @returns Whether the configured requirement is complete.
 */
export const isEvidenceComplete = <Subject, Evidence>(
  progress: EvidenceProgress<Subject, Evidence>,
): boolean => progress.evidenceBySigner.length >= progress.requiredSigners;

/**
 * Returns a detached complete snapshot when collection is complete.
 *
 * @param progress Fixed-member evidence collected for one subject.
 * @returns Complete evidence, or null while collection continues.
 */
export const completeEvidence = <Subject, Evidence>(
  progress: EvidenceProgress<Subject, Evidence>,
): CompleteEvidence<Subject, Evidence> | null =>
  isEvidenceComplete(progress) ? snapshotProgress(progress) : null;

/**
 * Merges one verified item without retaining mutable caller collections.
 *
 * @param input Current progress, verified item, and trusted equalities.
 * @returns Updated progress or one closed binding/member failure.
 */
export const mergeVerifiedEvidence = <Subject, Evidence>(
  input: EvidenceMergeInput<Subject, Evidence>,
): Either.Either<
  EvidenceMerge<Subject, Evidence>,
  | ConflictingSignerEvidenceError<Evidence>
  | EvidenceSubjectMismatchError<Subject>
  | NonMemberEvidenceSignerError
> => {
  const bindingFailure = findBindingFailure(input);
  if (bindingFailure !== null) {
    return Either.left(bindingFailure);
  }
  const existing = input.progress.evidenceBySigner.find(
    (item) => item.signerAgentId === input.received.signerAgentId,
  );
  if (existing !== undefined) {
    return mergeExistingEvidence(input, existing);
  }
  return Either.right(mergeNewEvidence(input));
};

function findBindingFailure<Subject, Evidence>(
  input: EvidenceMergeInput<Subject, Evidence>,
): EvidenceSubjectMismatchError<Subject> | NonMemberEvidenceSignerError | null {
  const { progress, received } = input;
  if (!input.sameSubject(progress.subject, received.subject)) {
    return new EvidenceSubjectMismatchError({
      expectedSubject: progress.subject,
      receivedSubject: received.subject,
    });
  }
  if (!progress.memberAgentIds.includes(received.signerAgentId)) {
    return new NonMemberEvidenceSignerError({
      signerAgentId: received.signerAgentId,
    });
  }
  return null;
}

function mergeExistingEvidence<Subject, Evidence>(
  input: EvidenceMergeInput<Subject, Evidence>,
  existing: SignerEvidence<Evidence>,
): Either.Either<
  EvidenceMerge<Subject, Evidence>,
  ConflictingSignerEvidenceError<Evidence>
> {
  if (!input.sameEvidence(existing.evidence, input.received.evidence)) {
    return Either.left(
      new ConflictingSignerEvidenceError({
        signerAgentId: input.received.signerAgentId,
        existingEvidence: existing.evidence,
        receivedEvidence: input.received.evidence,
      }),
    );
  }
  return Either.right(successfulMerge(input.progress, "duplicate", false));
}

function mergeNewEvidence<Subject, Evidence>(
  input: EvidenceMergeInput<Subject, Evidence>,
): EvidenceMerge<Subject, Evidence> {
  const { progress, received } = input;
  const wasComplete = isEvidenceComplete(progress);
  const nextProgress = Object.freeze({
    ...progress,
    evidenceBySigner: Object.freeze([
      ...progress.evidenceBySigner,
      Object.freeze({ ...received }),
    ]),
  });
  const newlyCompleted = !wasComplete && isEvidenceComplete(nextProgress);
  let disposition: EvidenceDisposition = "collecting";
  if (newlyCompleted) {
    disposition = "completed";
  } else if (wasComplete) {
    disposition = "enriched";
  }
  return successfulMerge(nextProgress, disposition, newlyCompleted);
}

function successfulMerge<Subject, Evidence>(
  progress: EvidenceProgress<Subject, Evidence>,
  disposition: EvidenceDisposition,
  newlyCompleted: boolean,
): EvidenceMerge<Subject, Evidence> {
  return Object.freeze({
    progress,
    disposition,
    newlyCompleted,
    completion: completeEvidence(progress),
  });
}

function snapshotProgress<Subject, Evidence>(
  progress: EvidenceProgress<Subject, Evidence>,
): EvidenceProgress<Subject, Evidence> {
  return Object.freeze({
    ...progress,
    memberAgentIds: Object.freeze([...progress.memberAgentIds]),
    evidenceBySigner: Object.freeze(
      progress.evidenceBySigner.map((item) => Object.freeze({ ...item })),
    ),
  });
}
