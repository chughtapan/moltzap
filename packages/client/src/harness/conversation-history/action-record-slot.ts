/**
 * @file Guards one endpoint's staged action-certified record within the exact
 * domain where an honest member must not cast durability votes for
 * conflicting children.
 */

import { Data, Either } from "effect";

import type {
  CertifiedHistoryHead,
  StagedActionCertifiedRecord,
} from "./certified-head-advance.js";

/** The fields that define one non-conflicting action-record signing domain. */
export interface ActionRecordSigningDomain<
  Conversation,
  MembershipEpoch,
  RecordHash,
> {
  readonly conversation: Conversation;
  readonly membershipEpoch: MembershipEpoch;
  /** `null` identifies the empty-history anchor extended by genesis. */
  readonly currentCertifiedRecordHash: RecordHash | null;
}

/** One verified action-certified record loaded from or ready for its slot. */
export interface StagedActionRecordCandidate<
  Conversation,
  MembershipEpoch,
  RecordHash,
  Record,
> {
  readonly domain: ActionRecordSigningDomain<
    Conversation,
    MembershipEpoch,
    RecordHash
  >;
  readonly stagedRecord: StagedActionCertifiedRecord<RecordHash, Record>;
}

/** The candidate or its signing domain does not extend the current head. */
export class ActionRecordPredecessorMismatchError<
  RecordHash,
> extends Data.TaggedError("ActionRecordPredecessorMismatchError")<{
  readonly expectedPreviousRecordHash: RecordHash | null;
  readonly receivedDomainRecordHash: RecordHash | null;
  readonly receivedPreviousRecordHash: RecordHash | null;
}> {}

/** A store returned a slot belonging to another action-record domain. */
export class ActionRecordSlotDomainMismatchError<
  Domain,
> extends Data.TaggedError("ActionRecordSlotDomainMismatchError")<{
  readonly expectedDomain: Domain;
  readonly storedDomain: Domain;
}> {}

/** The slot already contains another child of the same certified head. */
export class ConflictingActionRecordChildError<
  RecordHash,
> extends Data.TaggedError("ConflictingActionRecordChildError")<{
  readonly stagedRecordHash: RecordHash;
  readonly receivedRecordHash: RecordHash;
}> {}

/** Closed result meanings before the caller commits its durable transaction. */
export const actionRecordSlotDisposition = {
  staged: "staged",
  duplicate: "duplicate",
} as const;

type ActionRecordSlotDisposition =
  (typeof actionRecordSlotDisposition)[keyof typeof actionRecordSlotDisposition];

/** Immutable candidate-slot transition planned for endpoint-local storage. */
export interface ActionRecordSlotStage<
  Conversation,
  MembershipEpoch,
  RecordHash,
  Record,
> {
  readonly candidate: StagedActionRecordCandidate<
    Conversation,
    MembershipEpoch,
    RecordHash,
    Record
  >;
  readonly disposition: ActionRecordSlotDisposition;
}

/** Private inputs loaded for one action-record signing-domain slot. */
interface ActionRecordSlotInput<
  Conversation,
  MembershipEpoch,
  RecordHash,
  Record,
> {
  readonly currentHead: CertifiedHistoryHead<RecordHash>;
  readonly existing?: StagedActionRecordCandidate<
    Conversation,
    MembershipEpoch,
    RecordHash,
    Record
  >;
  readonly received: StagedActionRecordCandidate<
    Conversation,
    MembershipEpoch,
    RecordHash,
    Record
  >;
  readonly sameDomain: (
    left: ActionRecordSigningDomain<Conversation, MembershipEpoch, RecordHash>,
    right: ActionRecordSigningDomain<Conversation, MembershipEpoch, RecordHash>,
  ) => boolean;
  readonly sameRecordHash: (left: RecordHash, right: RecordHash) => boolean;
}

/**
 * Plans the only safe transition for a single action-record staging slot.
 *
 * The caller loads a slot keyed by conversation, immutable membership epoch,
 * and current certified head. This plan never authorizes signing by itself.
 * Only after the caller durably commits a newly `staged` candidate may it sign
 * a durability vote for that action-certified record. A `duplicate` result
 * merely reports the existing durable slot.
 *
 * @param input Current head, durable slot, verified candidate, and equality.
 * @returns A stage/duplicate result or one closed fail-closed reason.
 */
export const stageVerifiedActionRecord = <
  Conversation,
  MembershipEpoch,
  RecordHash,
  Record,
>(
  input: ActionRecordSlotInput<
    Conversation,
    MembershipEpoch,
    RecordHash,
    Record
  >,
): Either.Either<
  ActionRecordSlotStage<Conversation, MembershipEpoch, RecordHash, Record>,
  | ActionRecordPredecessorMismatchError<RecordHash>
  | ActionRecordSlotDomainMismatchError<
      ActionRecordSigningDomain<Conversation, MembershipEpoch, RecordHash>
    >
  | ConflictingActionRecordChildError<RecordHash>
> => {
  const predecessorMismatch = findPredecessorMismatch(input);
  if (predecessorMismatch !== null) {
    return Either.left(predecessorMismatch);
  }

  if (input.existing === undefined) {
    return Either.right({
      candidate: snapshotCandidate(input.received),
      disposition: actionRecordSlotDisposition.staged,
    });
  }
  const existingFailure = findExistingFailure(input.existing, input);
  if (existingFailure !== null) {
    return Either.left(existingFailure);
  }
  return Either.right({
    candidate: input.existing,
    disposition: actionRecordSlotDisposition.duplicate,
  });
};

function findExistingFailure<Conversation, MembershipEpoch, RecordHash, Record>(
  existing: StagedActionRecordCandidate<
    Conversation,
    MembershipEpoch,
    RecordHash,
    Record
  >,
  input: ActionRecordSlotInput<
    Conversation,
    MembershipEpoch,
    RecordHash,
    Record
  >,
):
  | ActionRecordSlotDomainMismatchError<
      ActionRecordSigningDomain<Conversation, MembershipEpoch, RecordHash>
    >
  | ConflictingActionRecordChildError<RecordHash>
  | null {
  if (!input.sameDomain(existing.domain, input.received.domain)) {
    return new ActionRecordSlotDomainMismatchError({
      expectedDomain: input.received.domain,
      storedDomain: existing.domain,
    });
  }
  if (
    input.sameRecordHash(
      existing.stagedRecord.recordHash,
      input.received.stagedRecord.recordHash,
    )
  ) {
    return null;
  }
  return new ConflictingActionRecordChildError({
    stagedRecordHash: existing.stagedRecord.recordHash,
    receivedRecordHash: input.received.stagedRecord.recordHash,
  });
}

function findPredecessorMismatch<
  Conversation,
  MembershipEpoch,
  RecordHash,
  Record,
>(
  input: ActionRecordSlotInput<
    Conversation,
    MembershipEpoch,
    RecordHash,
    Record
  >,
): ActionRecordPredecessorMismatchError<RecordHash> | null {
  const expectedPreviousRecordHash = previousHashFor(input.currentHead);
  const receivedDomainRecordHash =
    input.received.domain.currentCertifiedRecordHash;
  const receivedPreviousRecordHash =
    input.received.stagedRecord.previousRecordHash;
  if (
    sameOptionalHash(
      expectedPreviousRecordHash,
      receivedDomainRecordHash,
      input.sameRecordHash,
    ) &&
    sameOptionalHash(
      expectedPreviousRecordHash,
      receivedPreviousRecordHash,
      input.sameRecordHash,
    )
  ) {
    return null;
  }
  return new ActionRecordPredecessorMismatchError({
    expectedPreviousRecordHash,
    receivedDomainRecordHash,
    receivedPreviousRecordHash,
  });
}

function previousHashFor<RecordHash>(
  head: CertifiedHistoryHead<RecordHash>,
): RecordHash | null {
  return head._tag === "empty" ? null : head.recordHash;
}

function sameOptionalHash<RecordHash>(
  left: RecordHash | null,
  right: RecordHash | null,
  sameRecordHash: (left: RecordHash, right: RecordHash) => boolean,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return sameRecordHash(left, right);
}

function snapshotCandidate<Conversation, MembershipEpoch, RecordHash, Record>(
  candidate: StagedActionRecordCandidate<
    Conversation,
    MembershipEpoch,
    RecordHash,
    Record
  >,
): StagedActionRecordCandidate<
  Conversation,
  MembershipEpoch,
  RecordHash,
  Record
> {
  return Object.freeze({
    domain: Object.freeze({ ...candidate.domain }),
    stagedRecord: Object.freeze({ ...candidate.stagedRecord }),
  });
}
