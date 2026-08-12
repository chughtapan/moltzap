/**
 * @file Plans immutable action-certified records from closed body, membership,
 * Router-anchor, and unanimous-evidence bindings.
 */
import type { AgentId } from "@moltzap/identity";
import { Data, Either } from "effect";

import type { CompleteActionCertificate } from "./action-certificate-progress.js";
import { readonlyMapSnapshot } from "./immutable-collections.js";

/** Fixed membership verification material with its canonical member order. */
export interface FixedMembershipDescriptor<MembershipDescriptor> {
  readonly memberAgentIds: readonly AgentId[];
  readonly verificationDescriptor: MembershipDescriptor;
}

/** The action certificate was completed for another canonical body. */
export class ActionCertifiedBodyMismatchError<
  ActionBodyHash,
> extends Data.TaggedError("ActionCertifiedBodyMismatchError")<{
  readonly expectedActionBodyHash: ActionBodyHash;
  readonly certificateActionBodyHash: ActionBodyHash;
}> {}

/** The fixed membership descriptor repeats one AgentId. */
export class DuplicateFixedMemberError extends Data.TaggedError(
  "DuplicateFixedMemberError",
)<{
  readonly duplicateAgentId: AgentId;
}> {}

/** The certificate signer map does not equal the fixed membership. */
export class ActionCertificateSignerSetMismatchError extends Data.TaggedError(
  "ActionCertificateSignerSetMismatchError",
)<{
  readonly missingSignerAgentIds: readonly AgentId[];
  readonly extraSignerAgentIds: readonly AgentId[];
}> {}

/** Immutable material ready for canonical action-certified record hashing. */
export interface ActionCertifiedRecord<
  RecordBody,
  MembershipDescriptor,
  RouterAnchorHash,
  ActionBodyHash,
  SignatureEvidence,
> {
  readonly recordBody: RecordBody;
  readonly actionBodyHash: ActionBodyHash;
  readonly fixedMembership: FixedMembershipDescriptor<MembershipDescriptor>;
  readonly routerAnchorHash: RouterAnchorHash;
  readonly actionCertificate: CompleteActionCertificate<
    ActionBodyHash,
    SignatureEvidence
  >;
}

interface ActionCertifiedRecordInput<
  RecordBody,
  MembershipDescriptor,
  RouterAnchorHash,
  ActionBodyHash,
  SignatureEvidence,
> {
  readonly recordBody: RecordBody;
  readonly actionBodyHash: ActionBodyHash;
  readonly fixedMembership: FixedMembershipDescriptor<MembershipDescriptor>;
  readonly routerAnchorHash: RouterAnchorHash;
  readonly actionCertificate: CompleteActionCertificate<
    ActionBodyHash,
    SignatureEvidence
  >;
  readonly sameActionBodyHash: (
    left: ActionBodyHash,
    right: ActionBodyHash,
  ) => boolean;
}

/**
 * Validates closed bindings and snapshots one action-certified record.
 *
 * Body binding fails before membership inspection. Descriptor order is already
 * canonical and is preserved for the returned signer-evidence iteration.
 * This helper chooses no hash, signature, wire, or storage representation.
 *
 * @param input Verified opaque record components and body-hash equality.
 * @returns An immutable envelope or one typed binding failure.
 */
export const planActionCertifiedRecord = <
  RecordBody,
  MembershipDescriptor,
  RouterAnchorHash,
  ActionBodyHash,
  SignatureEvidence,
>(
  input: ActionCertifiedRecordInput<
    RecordBody,
    MembershipDescriptor,
    RouterAnchorHash,
    ActionBodyHash,
    SignatureEvidence
  >,
): Either.Either<
  ActionCertifiedRecord<
    RecordBody,
    MembershipDescriptor,
    RouterAnchorHash,
    ActionBodyHash,
    SignatureEvidence
  >,
  | ActionCertifiedBodyMismatchError<ActionBodyHash>
  | ActionCertificateSignerSetMismatchError
  | DuplicateFixedMemberError
> => {
  return Either.map(validateRecordBindings(input), (members) =>
    snapshotRecord(input, members),
  );
};

function validateRecordBindings<
  RecordBody,
  MembershipDescriptor,
  RouterAnchorHash,
  ActionBodyHash,
  SignatureEvidence,
>(
  input: ActionCertifiedRecordInput<
    RecordBody,
    MembershipDescriptor,
    RouterAnchorHash,
    ActionBodyHash,
    SignatureEvidence
  >,
): Either.Either<
  readonly AgentId[],
  | ActionCertifiedBodyMismatchError<ActionBodyHash>
  | ActionCertificateSignerSetMismatchError
  | DuplicateFixedMemberError
> {
  if (
    !input.sameActionBodyHash(
      input.actionBodyHash,
      input.actionCertificate.actionBodyHash,
    )
  ) {
    return Either.left(
      new ActionCertifiedBodyMismatchError({
        expectedActionBodyHash: input.actionBodyHash,
        certificateActionBodyHash: input.actionCertificate.actionBodyHash,
      }),
    );
  }
  const members = [...input.fixedMembership.memberAgentIds];
  const duplicateAgentId = firstDuplicate(members);
  if (duplicateAgentId !== null) {
    return Either.left(new DuplicateFixedMemberError({ duplicateAgentId }));
  }
  const signerFailure = findSignerFailure(
    members,
    input.actionCertificate.signatureEvidenceBySigner,
  );
  return signerFailure === null
    ? Either.right(Object.freeze(members))
    : Either.left(signerFailure);
}

function snapshotRecord<
  RecordBody,
  MembershipDescriptor,
  RouterAnchorHash,
  ActionBodyHash,
  SignatureEvidence,
>(
  input: ActionCertifiedRecordInput<
    RecordBody,
    MembershipDescriptor,
    RouterAnchorHash,
    ActionBodyHash,
    SignatureEvidence
  >,
  members: readonly AgentId[],
): ActionCertifiedRecord<
  RecordBody,
  MembershipDescriptor,
  RouterAnchorHash,
  ActionBodyHash,
  SignatureEvidence
> {
  return Object.freeze({
    recordBody: input.recordBody,
    actionBodyHash: input.actionBodyHash,
    fixedMembership: Object.freeze({
      memberAgentIds: members,
      verificationDescriptor: input.fixedMembership.verificationDescriptor,
    }),
    routerAnchorHash: input.routerAnchorHash,
    actionCertificate: Object.freeze({
      actionBodyHash: input.actionCertificate.actionBodyHash,
      signatureEvidenceBySigner: canonicalEvidenceSnapshot(
        members,
        input.actionCertificate.signatureEvidenceBySigner,
      ),
    }),
  });
}

function firstDuplicate(members: readonly AgentId[]): AgentId | null {
  const seen = new Set<AgentId>();
  for (const memberAgentId of members) {
    if (seen.has(memberAgentId)) {
      return memberAgentId;
    }
    seen.add(memberAgentId);
  }
  return null;
}

function findSignerFailure<SignatureEvidence>(
  members: readonly AgentId[],
  evidenceBySigner: ReadonlyMap<AgentId, SignatureEvidence>,
): ActionCertificateSignerSetMismatchError | null {
  const memberSet = new Set(members);
  const missingSignerAgentIds = members.filter(
    (memberAgentId) => !evidenceBySigner.has(memberAgentId),
  );
  const extraSignerAgentIds = [...evidenceBySigner.keys()].filter(
    (signerAgentId) => !memberSet.has(signerAgentId),
  );
  if (missingSignerAgentIds.length === 0 && extraSignerAgentIds.length === 0) {
    return null;
  }
  return new ActionCertificateSignerSetMismatchError({
    missingSignerAgentIds: Object.freeze(missingSignerAgentIds),
    extraSignerAgentIds: Object.freeze(extraSignerAgentIds),
  });
}

function canonicalEvidenceSnapshot<SignatureEvidence>(
  members: readonly AgentId[],
  evidenceBySigner: ReadonlyMap<AgentId, SignatureEvidence>,
): ReadonlyMap<AgentId, SignatureEvidence> {
  return readonlyMapSnapshot(
    members.map((memberAgentId) => [
      memberAgentId,
      /* Safe because exact signer-set validation precedes snapshot assembly. */ evidenceBySigner.get(
        memberAgentId,
      ) as SignatureEvidence,
    ]),
  );
}
