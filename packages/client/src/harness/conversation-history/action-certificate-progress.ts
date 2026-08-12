/**
 * @file Accumulates every fixed member's verified opaque signature evidence
 * for one OpenFloorV1 action body without invoking durability thresholds.
 */

import type { AgentId } from "@moltzap/identity";
import { Data, Either } from "effect";

/** Action-certificate collection cannot begin without a fixed member. */
export class EmptyActionCertificateMembershipError extends Data.TaggedError(
  "EmptyActionCertificateMembershipError",
)<{
  readonly memberCount: 0;
}> {}

/** One verified signature names another canonical action body. */
export class ActionCertificateBodyMismatchError<
  ActionBodyHash,
> extends Data.TaggedError("ActionCertificateBodyMismatchError")<{
  readonly expectedActionBodyHash: ActionBodyHash;
  readonly receivedActionBodyHash: ActionBodyHash;
}> {}

/** One verified action signer is outside the immutable fixed membership. */
export class NonMemberActionCertificateSignerError extends Data.TaggedError(
  "NonMemberActionCertificateSignerError",
)<{
  readonly signerAgentId: AgentId;
}> {}

/** One signer supplied different evidence after its first verified signature. */
export class ConflictingActionSignatureEvidenceError<
  SignatureEvidence,
> extends Data.TaggedError("ConflictingActionSignatureEvidenceError")<{
  readonly signerAgentId: AgentId;
  readonly existingEvidence: SignatureEvidence;
  readonly receivedEvidence: SignatureEvidence;
}> {}

/** Immutable exact-member signature progress for one action body. */
export interface ActionCertificateProgress<ActionBodyHash, SignatureEvidence> {
  readonly actionBodyHash: ActionBodyHash;
  readonly memberAgentIds: ReadonlySet<AgentId>;
  readonly signatureEvidenceBySigner: ReadonlyMap<AgentId, SignatureEvidence>;
}

/** Complete OpenFloorV1 evidence containing one signature per exact member. */
export interface CompleteActionCertificate<ActionBodyHash, SignatureEvidence> {
  readonly actionBodyHash: ActionBodyHash;
  readonly signatureEvidenceBySigner: ReadonlyMap<AgentId, SignatureEvidence>;
}

/** Closed meanings for one successful verified-signature merge. */
export const actionCertificateDisposition = {
  duplicate: "duplicate",
  collecting: "collecting",
  completed: "completed",
} as const;

type ActionCertificateDisposition =
  (typeof actionCertificateDisposition)[keyof typeof actionCertificateDisposition];

/** Immutable result of merging one already-verified action signature. */
export interface ActionCertificateMerge<ActionBodyHash, SignatureEvidence> {
  readonly progress: ActionCertificateProgress<
    ActionBodyHash,
    SignatureEvidence
  >;
  readonly disposition: ActionCertificateDisposition;
  /** Independent complete snapshot, present only when progress is unanimous. */
  readonly completion: CompleteActionCertificate<
    ActionBodyHash,
    SignatureEvidence
  > | null;
}

interface ActionCertificateProgressInput<ActionBodyHash> {
  readonly actionBodyHash: ActionBodyHash;
  readonly memberAgentIds: ReadonlySet<AgentId>;
}

/** One signature whose cryptographic evidence is already fully verified. */
interface VerifiedActionSignature<ActionBodyHash, SignatureEvidence> {
  readonly actionBodyHash: ActionBodyHash;
  readonly signerAgentId: AgentId;
  readonly evidence: SignatureEvidence;
}

interface ActionCertificateMergeInput<ActionBodyHash, SignatureEvidence> {
  readonly progress: ActionCertificateProgress<
    ActionBodyHash,
    SignatureEvidence
  >;
  readonly signature: VerifiedActionSignature<
    ActionBodyHash,
    SignatureEvidence
  >;
  readonly sameActionBodyHash: (
    left: ActionBodyHash,
    right: ActionBodyHash,
  ) => boolean;
  readonly sameSignatureEvidence: (
    left: SignatureEvidence,
    right: SignatureEvidence,
  ) => boolean;
}

/**
 * Starts unanimous action-certificate collection for one immutable membership.
 *
 * @param input Action-body identity and complete nonempty fixed membership.
 * @returns Empty progress or a typed empty-membership failure.
 */
export const makeActionCertificateProgress = <
  ActionBodyHash,
  SignatureEvidence,
>(
  input: ActionCertificateProgressInput<ActionBodyHash>,
): Either.Either<
  ActionCertificateProgress<ActionBodyHash, SignatureEvidence>,
  EmptyActionCertificateMembershipError
> => {
  if (input.memberAgentIds.size === 0) {
    return Either.left(
      new EmptyActionCertificateMembershipError({ memberCount: 0 }),
    );
  }
  return Either.right(
    Object.freeze({
      actionBodyHash: input.actionBodyHash,
      memberAgentIds: readonlySetSnapshot(input.memberAgentIds),
      signatureEvidenceBySigner: readonlyMapSnapshot(
        new Map<AgentId, SignatureEvidence>(),
      ),
    }),
  );
};

/**
 * Merges one signature after its evidence and signed fields are verified.
 *
 * Completion requires evidence from every exact fixed member. This helper
 * deliberately does not import or apply the separate durability threshold.
 *
 * @param input Current progress, verified signature, and trusted equalities.
 * @returns Copy-on-write progress or one closed fail-closed reason.
 */
export const mergeVerifiedActionSignature = <ActionBodyHash, SignatureEvidence>(
  input: ActionCertificateMergeInput<ActionBodyHash, SignatureEvidence>,
): Either.Either<
  ActionCertificateMerge<ActionBodyHash, SignatureEvidence>,
  | ActionCertificateBodyMismatchError<ActionBodyHash>
  | ConflictingActionSignatureEvidenceError<SignatureEvidence>
  | NonMemberActionCertificateSignerError
> => {
  const { progress, signature } = input;
  if (
    !input.sameActionBodyHash(progress.actionBodyHash, signature.actionBodyHash)
  ) {
    return Either.left(
      new ActionCertificateBodyMismatchError({
        expectedActionBodyHash: progress.actionBodyHash,
        receivedActionBodyHash: signature.actionBodyHash,
      }),
    );
  }
  if (!progress.memberAgentIds.has(signature.signerAgentId)) {
    return Either.left(
      new NonMemberActionCertificateSignerError({
        signerAgentId: signature.signerAgentId,
      }),
    );
  }
  return mergeMemberSignature(input);
};

function mergeMemberSignature<ActionBodyHash, SignatureEvidence>(
  input: ActionCertificateMergeInput<ActionBodyHash, SignatureEvidence>,
): Either.Either<
  ActionCertificateMerge<ActionBodyHash, SignatureEvidence>,
  ConflictingActionSignatureEvidenceError<SignatureEvidence>
> {
  const { progress, signature } = input;
  if (progress.signatureEvidenceBySigner.has(signature.signerAgentId)) {
    const existingEvidence =
      /* Safe because the preceding presence check distinguishes stored evidence from an absent signer. */ progress.signatureEvidenceBySigner.get(
        signature.signerAgentId,
      ) as SignatureEvidence;
    if (!input.sameSignatureEvidence(existingEvidence, signature.evidence)) {
      return Either.left(
        new ConflictingActionSignatureEvidenceError({
          signerAgentId: signature.signerAgentId,
          existingEvidence,
          receivedEvidence: signature.evidence,
        }),
      );
    }
    return successfulMerge(progress, actionCertificateDisposition.duplicate);
  }
  return mergeNewSignature(progress, signature);
}

function mergeNewSignature<ActionBodyHash, SignatureEvidence>(
  progress: ActionCertificateProgress<ActionBodyHash, SignatureEvidence>,
  signature: VerifiedActionSignature<ActionBodyHash, SignatureEvidence>,
): Either.Either<ActionCertificateMerge<ActionBodyHash, SignatureEvidence>> {
  const mutableEvidence = new Map(progress.signatureEvidenceBySigner);
  mutableEvidence.set(signature.signerAgentId, signature.evidence);
  const signatureEvidenceBySigner = readonlyMapSnapshot(mutableEvidence);
  const nextProgress = Object.freeze({
    ...progress,
    signatureEvidenceBySigner,
  });
  return successfulMerge(
    nextProgress,
    isComplete(nextProgress)
      ? actionCertificateDisposition.completed
      : actionCertificateDisposition.collecting,
  );
}

function successfulMerge<ActionBodyHash, SignatureEvidence>(
  progress: ActionCertificateProgress<ActionBodyHash, SignatureEvidence>,
  disposition: ActionCertificateDisposition,
): Either.Either<ActionCertificateMerge<ActionBodyHash, SignatureEvidence>> {
  return Either.right({
    progress,
    disposition,
    completion: isComplete(progress) ? snapshotCompletion(progress) : null,
  });
}

function isComplete<ActionBodyHash, SignatureEvidence>(
  progress: ActionCertificateProgress<ActionBodyHash, SignatureEvidence>,
): boolean {
  if (
    progress.signatureEvidenceBySigner.size !== progress.memberAgentIds.size
  ) {
    return false;
  }
  for (const memberAgentId of progress.memberAgentIds) {
    if (!progress.signatureEvidenceBySigner.has(memberAgentId)) {
      return false;
    }
  }
  return true;
}

function snapshotCompletion<ActionBodyHash, SignatureEvidence>(
  progress: ActionCertificateProgress<ActionBodyHash, SignatureEvidence>,
): CompleteActionCertificate<ActionBodyHash, SignatureEvidence> {
  return Object.freeze({
    actionBodyHash: progress.actionBodyHash,
    signatureEvidenceBySigner: readonlyMapSnapshot(
      progress.signatureEvidenceBySigner,
    ),
  });
}

function readonlySetSnapshot<Value>(
  values: Iterable<Value>,
): ReadonlySet<Value> {
  const snapshot = new Set(values);
  const view: ReadonlySet<Value> = {
    get size() {
      return snapshot.size;
    },
    has: (value: Value) => snapshot.has(value),
    entries: () => snapshot.entries(),
    keys: () => snapshot.keys(),
    values: () => snapshot.values(),
    forEach: (...parameters: Parameters<ReadonlySet<Value>["forEach"]>) => {
      const callback = parameters[0];
      const thisArgument: unknown = parameters[1];
      for (const value of snapshot) {
        if (thisArgument === undefined) {
          callback(value, value, view);
        } else {
          callback.call(thisArgument, value, value, view);
        }
      }
    },
    [Symbol.iterator]: () => snapshot[Symbol.iterator](),
  };
  return Object.freeze(view);
}

function readonlyMapSnapshot<Key, Value>(
  entries: Iterable<readonly [Key, Value]>,
): ReadonlyMap<Key, Value> {
  const snapshot = new Map(entries);
  const view: ReadonlyMap<Key, Value> = {
    get size() {
      return snapshot.size;
    },
    get: (key: Key) => snapshot.get(key),
    has: (key: Key) => snapshot.has(key),
    entries: () => snapshot.entries(),
    keys: () => snapshot.keys(),
    values: () => snapshot.values(),
    forEach: (
      ...parameters: Parameters<ReadonlyMap<Key, Value>["forEach"]>
    ) => {
      const callback = parameters[0];
      const thisArgument: unknown = parameters[1];
      for (const [key, value] of snapshot) {
        if (thisArgument === undefined) {
          callback(value, key, view);
        } else {
          callback.call(thisArgument, value, key, view);
        }
      }
    },
    [Symbol.iterator]: () => snapshot[Symbol.iterator](),
  };
  return Object.freeze(view);
}
