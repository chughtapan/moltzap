/**
 * @file Guards one endpoint's staged Router re-anchor candidate within the
 * exact domain where an honest member must not sign conflicting bodies.
 */

import { Data, Either } from "effect";

/** The fields that define one non-conflicting re-anchor signing domain. */
export interface ReanchorSigningDomain<
  Conversation,
  MembershipEpoch,
  AnchorHash,
  RouterInstance,
> {
  readonly conversation: Conversation;
  readonly membershipEpoch: MembershipEpoch;
  readonly precedingAnchorHash: AnchorHash;
  readonly routerInstance: RouterInstance;
}

/** One verified candidate loaded from or ready for durable staging. */
export interface StagedReanchorCandidate<Domain, BodyHash> {
  readonly domain: Domain;
  readonly bodyHash: BodyHash;
}

/** A store returned a slot belonging to another signing domain. */
export class ReanchorSlotDomainMismatchError<Domain> extends Data.TaggedError(
  "ReanchorSlotDomainMismatchError",
)<{
  readonly expectedDomain: Domain;
  readonly receivedDomain: Domain;
}> {}

/** The slot already contains a conflicting body in the same domain. */
export class ConflictingReanchorCandidateError<
  BodyHash,
> extends Data.TaggedError("ConflictingReanchorCandidateError")<{
  readonly stagedBodyHash: BodyHash;
  readonly receivedBodyHash: BodyHash;
}> {}

/** Closed result meanings before the caller commits its durable transaction. */
export const reanchorCandidateDisposition = {
  staged: "staged",
  duplicate: "duplicate",
} as const;

type ReanchorCandidateDisposition =
  (typeof reanchorCandidateDisposition)[keyof typeof reanchorCandidateDisposition];

/** Immutable candidate-slot transition planned for durable storage. */
export interface ReanchorCandidateStage<Domain, BodyHash> {
  readonly candidate: StagedReanchorCandidate<Domain, BodyHash>;
  readonly disposition: ReanchorCandidateDisposition;
}

/** Private inputs for one store slot keyed by re-anchor signing domain. */
interface ReanchorCandidateSlotInput<Domain, BodyHash> {
  readonly staged?: StagedReanchorCandidate<Domain, BodyHash>;
  readonly received: StagedReanchorCandidate<Domain, BodyHash>;
  readonly sameDomain: (left: Domain, right: Domain) => boolean;
  readonly sameBodyHash: (left: BodyHash, right: BodyHash) => boolean;
}

/**
 * Plans the only safe transition for a single durable re-anchor slot.
 *
 * The caller loads and atomically commits a slot keyed by conversation,
 * membership epoch, preceding anchor, and Router instance. A new candidate is
 * eligible for staging, an identical retry is harmless, and a conflicting
 * body fails closed. This helper does not authorize signing before the caller
 * has durably committed the returned candidate.
 *
 * @param input Current durable slot, verified candidate, and trusted equality.
 * @returns A stage/duplicate result or a closed domain/conflict failure.
 */
export const stageVerifiedReanchorCandidate = <Domain, BodyHash>(
  input: ReanchorCandidateSlotInput<Domain, BodyHash>,
): Either.Either<
  ReanchorCandidateStage<Domain, BodyHash>,
  | ConflictingReanchorCandidateError<BodyHash>
  | ReanchorSlotDomainMismatchError<Domain>
> => {
  if (input.staged === undefined) {
    return Either.right({
      candidate: snapshotCandidate(input.received),
      disposition: reanchorCandidateDisposition.staged,
    });
  }
  if (!input.sameDomain(input.staged.domain, input.received.domain)) {
    return Either.left(
      new ReanchorSlotDomainMismatchError({
        expectedDomain: input.staged.domain,
        receivedDomain: input.received.domain,
      }),
    );
  }
  if (!input.sameBodyHash(input.staged.bodyHash, input.received.bodyHash)) {
    return Either.left(
      new ConflictingReanchorCandidateError({
        stagedBodyHash: input.staged.bodyHash,
        receivedBodyHash: input.received.bodyHash,
      }),
    );
  }
  return Either.right({
    candidate: input.staged,
    disposition: reanchorCandidateDisposition.duplicate,
  });
};

function snapshotCandidate<Domain, BodyHash>(
  candidate: StagedReanchorCandidate<Domain, BodyHash>,
): StagedReanchorCandidate<Domain, BodyHash> {
  return Object.freeze({ ...candidate });
}
