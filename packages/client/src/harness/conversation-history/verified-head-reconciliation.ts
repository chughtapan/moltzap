/**
 * @file Reconciles already-verified complete conversation ancestries before
 * Router-epoch re-anchoring.
 *
 * Cryptographic and membership verification happen before this private seam.
 * The selector only enforces that every presented head lies on one chain and
 * therefore cannot guess between forks or incomplete catch-up results.
 */

import { Data, Either } from "effect";

/** A complete verified ancestry ordered from genesis through its head. */
export type NonEmptyAncestry<Hash> = readonly [Hash, ...Hash[]];

/**
 * One fixed member's verified history view.
 *
 * An incomplete view carries no selectable position: catch-up must finish and
 * verification must produce a complete ancestry before reconciliation retries.
 */
export type VerifiedHeadPresentation<Hash> =
  | Readonly<{
      readonly _tag: "complete";
      readonly recordHashes: NonEmptyAncestry<Hash>;
    }>
  | Readonly<{
      readonly _tag: "incomplete";
    }>;

/** The selected head and an independent snapshot of its verified ancestry. */
export interface ReconciledVerifiedHead<Hash> {
  readonly selectedRecordHash: Hash;
  readonly recordHashes: NonEmptyAncestry<Hash>;
}

/** A fixed member has not supplied the verified ancestry needed to continue. */
export class MissingRequiredAncestryError extends Data.TaggedError(
  "MissingRequiredAncestryError",
)<{
  readonly presentationIndex: number;
}> {}

/** Two complete verified histories fork rather than extending one another. */
export class IncomparableVerifiedHeadsError extends Data.TaggedError(
  "IncomparableVerifiedHeadsError",
)<{
  readonly firstPresentationIndex: number;
  readonly secondPresentationIndex: number;
}> {}

/** Private inputs supplied only after fixed-member history verification. */
interface VerifiedHeadReconciliationInput<Hash> {
  readonly presentations: readonly [
    VerifiedHeadPresentation<Hash>,
    ...Array<VerifiedHeadPresentation<Hash>>,
  ];
  readonly sameRecordHash: (left: Hash, right: Hash) => boolean;
}

/** One complete presentation paired with its stable input position. */
interface IndexedCompletePresentation<Hash> {
  readonly presentationIndex: number;
  readonly recordHashes: NonEmptyAncestry<Hash>;
}

/** Verification preserves at least the first fixed member's presentation. */
type NonEmptyCompletePresentations<Hash> = readonly [
  IndexedCompletePresentation<Hash>,
  ...Array<IndexedCompletePresentation<Hash>>,
];

/**
 * Selects the sole verified head that equals or descends from every presented
 * head.
 *
 * Hash equality is supplied by the caller so this private algorithm commits
 * to no RecordHash representation or serialization.
 *
 * @param input Complete fixed-member presentations and trusted hash equality.
 * @param input.presentations One nonempty presentation per required member.
 * @param input.sameRecordHash Equality for the caller's verified hash values.
 * @returns The unique descendant ancestry, or a fail-closed recovery error.
 */
export const reconcileVerifiedHeads = <Hash>(
  input: VerifiedHeadReconciliationInput<Hash>,
): Either.Either<
  ReconciledVerifiedHead<Hash>,
  MissingRequiredAncestryError | IncomparableVerifiedHeadsError
> => {
  const selectionResult = Either.flatMap(
    collectCompletePresentations(input.presentations),
    (presentations) =>
      selectLongestComparable(presentations, input.sameRecordHash),
  );

  return Either.map(selectionResult, (selection) => {
    const recordHashes = snapshotAncestry(selection.recordHashes);
    return {
      selectedRecordHash: lastRecordHash(recordHashes),
      recordHashes,
    };
  });
};

function collectCompletePresentations<Hash>(
  presentations: VerifiedHeadReconciliationInput<Hash>["presentations"],
): Either.Either<
  NonEmptyCompletePresentations<Hash>,
  MissingRequiredAncestryError
> {
  const [first, ...remaining] = presentations;
  if (first._tag !== "complete") {
    return Either.left(
      new MissingRequiredAncestryError({ presentationIndex: 0 }),
    );
  }

  const completePresentations: [
    IndexedCompletePresentation<Hash>,
    ...Array<IndexedCompletePresentation<Hash>>,
  ] = [{ presentationIndex: 0, recordHashes: first.recordHashes }];
  for (const [offset, presentation] of remaining.entries()) {
    const presentationIndex = offset + 1;
    if (presentation._tag !== "complete") {
      return Either.left(
        new MissingRequiredAncestryError({ presentationIndex }),
      );
    }
    completePresentations.push({
      presentationIndex,
      recordHashes: presentation.recordHashes,
    });
  }
  return Either.right(completePresentations);
}

function selectLongestComparable<Hash>(
  presentations: NonEmptyCompletePresentations<Hash>,
  sameRecordHash: (left: Hash, right: Hash) => boolean,
): Either.Either<
  IndexedCompletePresentation<Hash>,
  IncomparableVerifiedHeadsError
> {
  const incomparablePair = findIncomparablePair(presentations, sameRecordHash);
  if (incomparablePair !== null) {
    return Either.left(
      new IncomparableVerifiedHeadsError({
        firstPresentationIndex: incomparablePair[0].presentationIndex,
        secondPresentationIndex: incomparablePair[1].presentationIndex,
      }),
    );
  }

  return Either.right(longestPresentation(presentations));
}

function findIncomparablePair<Hash>(
  presentations: NonEmptyCompletePresentations<Hash>,
  sameRecordHash: (left: Hash, right: Hash) => boolean,
):
  | readonly [
      IndexedCompletePresentation<Hash>,
      IndexedCompletePresentation<Hash>,
    ]
  | null {
  for (const [rightIndex, right] of presentations.entries()) {
    for (const left of presentations.slice(0, rightIndex)) {
      if (
        !arePrefixComparable(
          left.recordHashes,
          right.recordHashes,
          sameRecordHash,
        )
      ) {
        return [left, right];
      }
    }
  }
  return null;
}

function longestPresentation<Hash>(
  presentations: NonEmptyCompletePresentations<Hash>,
): IndexedCompletePresentation<Hash> {
  let longest = presentations[0];
  for (const candidate of presentations.slice(1)) {
    if (candidate.recordHashes.length > longest.recordHashes.length) {
      longest = candidate;
    }
  }
  return longest;
}

function arePrefixComparable<Hash>(
  left: NonEmptyAncestry<Hash>,
  right: NonEmptyAncestry<Hash>,
  sameRecordHash: (left: Hash, right: Hash) => boolean,
): boolean {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftHash = left[index];
    const rightHash = right[index];
    if (
      leftHash === undefined ||
      rightHash === undefined ||
      !sameRecordHash(leftHash, rightHash)
    ) {
      return false;
    }
  }
  return true;
}

function snapshotAncestry<Hash>(
  ancestry: NonEmptyAncestry<Hash>,
): NonEmptyAncestry<Hash> {
  const [genesis, ...descendants] = ancestry;
  return Object.freeze([genesis, ...descendants]);
}

function lastRecordHash<Hash>(ancestry: NonEmptyAncestry<Hash>): Hash {
  let head = ancestry[0];
  for (const recordHash of ancestry) {
    head = recordHash;
  }
  return head;
}
