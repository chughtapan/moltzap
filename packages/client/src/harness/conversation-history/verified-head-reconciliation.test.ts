/**
 * @file Pins fail-closed and order-independent selection of the one verified
 * conversation head eligible for Router-epoch re-anchoring.
 */

import { Either } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type IncomparableVerifiedHeadsError,
  type MissingRequiredAncestryError,
  type NonEmptyAncestry,
  type ReconciledVerifiedHead,
  reconcileVerifiedHeads,
  type VerifiedHeadPresentation,
} from "./verified-head-reconciliation.js";

interface OpaqueHash {
  readonly value: string;
}

type NonEmptyPresentations = readonly [
  VerifiedHeadPresentation<OpaqueHash>,
  ...Array<VerifiedHeadPresentation<OpaqueHash>>,
];

const GENESIS_HASH_VALUE = "genesis";
const SECOND_HASH_VALUE = "second";
const THIRD_HASH_VALUE = "third";
const PROPERTY_RECORD_PREFIX = "record-";

function selected(
  presentations: NonEmptyPresentations,
): ReconciledVerifiedHead<OpaqueHash> {
  return Either.match(
    reconcileVerifiedHeads({
      presentations,
      sameRecordHash: sameOpaqueHash,
    }),
    {
      onLeft: (error) => {
        throw error;
      },
      onRight: (head) => head,
    },
  );
}

function failed(
  presentations: NonEmptyPresentations,
): MissingRequiredAncestryError | IncomparableVerifiedHeadsError {
  return Either.match(
    reconcileVerifiedHeads({
      presentations,
      sameRecordHash: sameOpaqueHash,
    }),
    {
      onLeft: (error) => error,
      onRight: () => {
        throw new Error("Expected verified-head reconciliation to fail");
      },
    },
  );
}

function propertyFixture(prefixLengths: readonly number[]) {
  const fullAncestry = fullPropertyAncestry(prefixLengths.length);
  const presentationValues = prefixLengths.map((prefixLength) =>
    complete(nonEmptyAncestry(fullAncestry.slice(0, prefixLength))),
  );
  return {
    fullAncestry,
    presentations: nonEmptyPresentations(presentationValues),
  };
}

function fullPropertyAncestry(
  historyLength: number,
): NonEmptyAncestry<OpaqueHash> {
  return nonEmptyAncestry(
    prefixLengthsFor(historyLength).map((index) =>
      opaqueHash(`${PROPERTY_RECORD_PREFIX}${String(index - 1)}`),
    ),
  );
}

function complete(
  recordHashes: NonEmptyAncestry<OpaqueHash>,
): VerifiedHeadPresentation<OpaqueHash> {
  return {
    _tag: "complete",
    recordHashes,
  };
}

function ancestry(...values: readonly string[]): NonEmptyAncestry<OpaqueHash> {
  return nonEmptyAncestry(values.map((value) => opaqueHash(value)));
}

function prefixLengthsFor(historyLength: number): number[] {
  const prefixLengths: number[] = [];
  for (let length = 1; length <= historyLength; length += 1) {
    prefixLengths.push(length);
  }
  return prefixLengths;
}

function nonEmptyAncestry<Hash>(
  values: readonly Hash[],
): NonEmptyAncestry<Hash> {
  const [first, ...remaining] = values;
  if (first === undefined) {
    throw new Error("Verified ancestry fixtures must be nonempty");
  }
  return [first, ...remaining];
}

function nonEmptyPresentations(
  values: ReadonlyArray<VerifiedHeadPresentation<OpaqueHash>>,
): NonEmptyPresentations {
  const [first, ...remaining] = values;
  if (first === undefined) {
    throw new Error("Reconciliation fixtures must include a presentation");
  }
  return [first, ...remaining];
}

function sameOpaqueHash(left: OpaqueHash, right: OpaqueHash): boolean {
  return left.value === right.value;
}

function opaqueHash(value: string): OpaqueHash {
  return { value };
}

const shuffledPrefixLengthsArbitrary = fc
  .integer({ min: 1, max: 30 })
  .chain((historyLength) =>
    fc.shuffledSubarray(prefixLengthsFor(historyLength), {
      minLength: historyLength,
      maxLength: historyLength,
    }),
  );

describe("reconcileVerifiedHeads singleton and duplicate selection", () => {
  it("selects one complete singleton history", () => {
    const result = selected([complete(ancestry(GENESIS_HASH_VALUE))]);

    expect(result.selectedRecordHash.value).toBe(GENESIS_HASH_VALUE);
    expect(result.recordHashes.map((hash) => hash.value)).toEqual([
      GENESIS_HASH_VALUE,
    ]);
  });

  it("treats equal opaque hashes as duplicates without requiring object identity", () => {
    const first = ancestry(GENESIS_HASH_VALUE, SECOND_HASH_VALUE);
    const independentlyDecoded = ancestry(
      GENESIS_HASH_VALUE,
      SECOND_HASH_VALUE,
    );

    expect(first[0]).not.toBe(independentlyDecoded[0]);
    expect(
      selected([complete(first), complete(independentlyDecoded)]),
    ).toMatchObject({
      selectedRecordHash: { value: SECOND_HASH_VALUE },
    });
  });
});

describe("reconcileVerifiedHeads descendant selection", () => {
  it.each([
    [
      complete(ancestry(GENESIS_HASH_VALUE)),
      complete(
        ancestry(GENESIS_HASH_VALUE, SECOND_HASH_VALUE, THIRD_HASH_VALUE),
      ),
    ],
    [
      complete(
        ancestry(GENESIS_HASH_VALUE, SECOND_HASH_VALUE, THIRD_HASH_VALUE),
      ),
      complete(ancestry(GENESIS_HASH_VALUE)),
    ],
  ])(
    "selects a verified descendant regardless of arrival order",
    (left, right) => {
      const result = selected([left, right]);

      expect(result.selectedRecordHash.value).toBe(THIRD_HASH_VALUE);
      expect(result.recordHashes.map((hash) => hash.value)).toEqual([
        GENESIS_HASH_VALUE,
        SECOND_HASH_VALUE,
        THIRD_HASH_VALUE,
      ]);
    },
  );
});

describe("reconcileVerifiedHeads order law", () => {
  it("selects the same longest prefix across shuffled complete presentations", () => {
    fc.assert(
      fc.property(shuffledPrefixLengthsArbitrary, (prefixLengths) => {
        const fixture = propertyFixture(prefixLengths);
        const expectedHead = fixture.fullAncestry.at(-1);
        if (expectedHead === undefined) {
          throw new Error("Property ancestry must have a head");
        }

        expect(selected(fixture.presentations).selectedRecordHash.value).toBe(
          expectedHead.value,
        );
      }),
    );
  });
});

describe("reconcileVerifiedHeads refusal", () => {
  it("fails on any incomplete presentation before considering longer histories", () => {
    expect(
      failed([
        complete(
          ancestry(GENESIS_HASH_VALUE, SECOND_HASH_VALUE, THIRD_HASH_VALUE),
        ),
        { _tag: "incomplete" },
        complete(ancestry(GENESIS_HASH_VALUE)),
      ]),
    ).toMatchObject({
      _tag: "MissingRequiredAncestryError",
      presentationIndex: 1,
    });
  });

  it.each([
    [ancestry("first-genesis"), ancestry("second-genesis")],
    [
      ancestry(GENESIS_HASH_VALUE, "shared", "left"),
      ancestry(GENESIS_HASH_VALUE, "shared", "right"),
    ],
  ])("rejects incomparable verified histories", (left, right) => {
    expect(failed([complete(left), complete(right)])).toMatchObject({
      _tag: "IncomparableVerifiedHeadsError",
      firstPresentationIndex: 0,
      secondPresentationIndex: 1,
    });
  });
});

describe("reconcileVerifiedHeads snapshot ownership", () => {
  it("does not mutate or retain a mutable input ancestry", () => {
    const mutableInput: [OpaqueHash, ...OpaqueHash[]] = [
      opaqueHash(GENESIS_HASH_VALUE),
      opaqueHash(SECOND_HASH_VALUE),
    ];
    const inputSnapshot = [...mutableInput];
    const result = selected([complete(mutableInput)]);

    expect(mutableInput).toEqual(inputSnapshot);
    expect(result.recordHashes).not.toBe(mutableInput);
    expect(Object.isFrozen(result.recordHashes)).toBe(true);

    mutableInput.push(opaqueHash("later-input-mutation"));
    expect(result.recordHashes.map((hash) => hash.value)).toEqual([
      GENESIS_HASH_VALUE,
      SECOND_HASH_VALUE,
    ]);
  });
});
