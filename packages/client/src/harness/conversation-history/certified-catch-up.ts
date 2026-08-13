/**
 * @file Plans one verified certified-history suffix for atomic endpoint-local
 * catch-up without creating runtime attention or reply authority.
 */

import { Data, Either } from "effect";

import type { CertifiedHistoryHead } from "./state-machine.js";

/** One already-fully-verified complete certified record received for catch-up. */
export interface CompleteCertifiedRecordEnvelope<RecordHash, Record> {
  readonly recordHash: RecordHash;
  readonly previousRecordHash: RecordHash | null;
  readonly record: Record;
}

/** Catch-up always advances through at least one complete certified record. */
export type CertifiedCatchUpSuffix<RecordHash, Record> = readonly [
  CompleteCertifiedRecordEnvelope<RecordHash, Record>,
  ...Array<CompleteCertifiedRecordEnvelope<RecordHash, Record>>,
];

/** The received suffix does not begin at the endpoint's current head. */
class CatchUpAnchorMismatchError<RecordHash> extends Data.TaggedError(
  "CatchUpAnchorMismatchError",
)<{
  readonly expectedPreviousRecordHash: RecordHash | null;
  readonly receivedPreviousRecordHash: RecordHash | null;
}> {}

/** A later received record does not extend the preceding received record. */
class CatchUpSequenceGapError<RecordHash> extends Data.TaggedError(
  "CatchUpSequenceGapError",
)<{
  readonly recordIndex: number;
  readonly expectedPreviousRecordHash: RecordHash;
  readonly receivedPreviousRecordHash: RecordHash | null;
}> {}

/** One record hash occurs more than once within the received suffix. */
class RepeatedCatchUpRecordHashError<RecordHash> extends Data.TaggedError(
  "RepeatedCatchUpRecordHashError",
)<{
  readonly firstRecordHash: RecordHash;
  readonly repeatedRecordHash: RecordHash;
  readonly firstIndex: number;
  readonly repeatedIndex: number;
}> {}

/** One immutable suffix transition suitable for an atomic store transaction. */
export interface CertifiedCatchUpPlan<RecordHash, Record> {
  /** Independent frozen snapshot in canonical predecessor order. */
  readonly suffix: CertifiedCatchUpSuffix<RecordHash, Record>;
  /** Certified head after every planned record is atomically committed. */
  readonly nextHead: CertifiedHistoryHead<RecordHash>;
}

/** Private inputs after every received envelope has been fully verified. */
interface CertifiedCatchUpInput<RecordHash, Record> {
  readonly currentHead: CertifiedHistoryHead<RecordHash>;
  readonly suffix: CertifiedCatchUpSuffix<RecordHash, Record>;
  readonly sameRecordHash: (left: RecordHash, right: RecordHash) => boolean;
}

type CatchUpFailure<RecordHash> =
  | CatchUpAnchorMismatchError<RecordHash>
  | CatchUpSequenceGapError<RecordHash>
  | RepeatedCatchUpRecordHashError<RecordHash>;

/**
 * Checks whether a verified nonempty suffix extends the local certified head.
 *
 * This function plans no mutation by itself. The caller atomically persists
 * the returned ordered suffix and next head. Catch-up remains a history-only
 * transition and cannot create a live turn or reply capability.
 *
 * @param input Current head, verified nonempty suffix, and trusted equality.
 * @returns An immutable catch-up plan or one closed fail-closed reason.
 */
export const planCertifiedCatchUp = <RecordHash, Record>(
  input: CertifiedCatchUpInput<RecordHash, Record>,
): Either.Either<
  CertifiedCatchUpPlan<RecordHash, Record>,
  CatchUpFailure<RecordHash>
> => {
  const [first, ...remaining] = input.suffix;
  const anchorMismatch = findAnchorMismatch(input, first);
  if (anchorMismatch !== null) {
    return Either.left(anchorMismatch);
  }

  const sequenceFailure = findSequenceFailure(
    first,
    remaining,
    input.sameRecordHash,
  );
  if (sequenceFailure !== null) {
    return Either.left(sequenceFailure);
  }

  const lastRecordHash = remaining.at(-1)?.recordHash ?? first.recordHash;
  return Either.right({
    suffix: snapshotSuffix(first, remaining),
    nextHead: Object.freeze({
      _tag: "certified" as const,
      recordHash: lastRecordHash,
    }),
  });
};

function findAnchorMismatch<RecordHash, Record>(
  input: CertifiedCatchUpInput<RecordHash, Record>,
  first: CompleteCertifiedRecordEnvelope<RecordHash, Record>,
): CatchUpAnchorMismatchError<RecordHash> | null {
  const expectedPreviousRecordHash = previousHashFor(input.currentHead);
  if (
    sameOptionalHash(
      expectedPreviousRecordHash,
      first.previousRecordHash,
      input.sameRecordHash,
    )
  ) {
    return null;
  }
  return new CatchUpAnchorMismatchError({
    expectedPreviousRecordHash,
    receivedPreviousRecordHash: first.previousRecordHash,
  });
}

function findSequenceFailure<RecordHash, Record>(
  first: CompleteCertifiedRecordEnvelope<RecordHash, Record>,
  remaining: ReadonlyArray<CompleteCertifiedRecordEnvelope<RecordHash, Record>>,
  sameRecordHash: (left: RecordHash, right: RecordHash) => boolean,
):
  | CatchUpSequenceGapError<RecordHash>
  | RepeatedCatchUpRecordHashError<RecordHash>
  | null {
  const seenRecordHashes: RecordHash[] = [first.recordHash];
  let previousRecordHash = first.recordHash;
  for (const [offset, received] of remaining.entries()) {
    const recordIndex = offset + 1;
    if (
      !sameOptionalHash(
        previousRecordHash,
        received.previousRecordHash,
        sameRecordHash,
      )
    ) {
      return new CatchUpSequenceGapError({
        recordIndex,
        expectedPreviousRecordHash: previousRecordHash,
        receivedPreviousRecordHash: received.previousRecordHash,
      });
    }
    const firstIndex = seenRecordHashes.findIndex((seen) =>
      sameRecordHash(seen, received.recordHash),
    );
    if (firstIndex !== -1) {
      const firstRecordHash =
        /* Safe because findIndex returned a valid array index. */ seenRecordHashes[
          firstIndex
        ] as RecordHash;
      return new RepeatedCatchUpRecordHashError({
        firstRecordHash,
        repeatedRecordHash: received.recordHash,
        firstIndex,
        repeatedIndex: recordIndex,
      });
    }
    seenRecordHashes.push(received.recordHash);
    previousRecordHash = received.recordHash;
  }
  return null;
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

function snapshotSuffix<RecordHash, Record>(
  first: CompleteCertifiedRecordEnvelope<RecordHash, Record>,
  remaining: ReadonlyArray<CompleteCertifiedRecordEnvelope<RecordHash, Record>>,
): CertifiedCatchUpSuffix<RecordHash, Record> {
  const snapshot: [
    CompleteCertifiedRecordEnvelope<RecordHash, Record>,
    ...Array<CompleteCertifiedRecordEnvelope<RecordHash, Record>>,
  ] = [Object.freeze({ ...first })];
  for (const envelope of remaining) {
    snapshot.push(Object.freeze({ ...envelope }));
  }
  return Object.freeze(snapshot);
}
