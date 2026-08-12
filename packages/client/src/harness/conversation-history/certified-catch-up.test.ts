/**
 * @file Pins anchor continuity, ordered ancestry, distinct record identity,
 * and immutable atomic plans for private certified-history catch-up.
 */

import { Either } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { CertifiedHistoryHead } from "./certified-head-advance.js";
import {
  type CertifiedCatchUpPlan,
  type CertifiedCatchUpSuffix,
  type CompleteCertifiedRecordEnvelope,
  planCertifiedCatchUp,
} from "./certified-catch-up.js";

type Envelope = CompleteCertifiedRecordEnvelope<string, string>;
type Suffix = CertifiedCatchUpSuffix<string, string>;

const envelope = (
  recordHash: string,
  previousRecordHash: string | null,
): Envelope => ({
  recordHash,
  previousRecordHash,
  record: `complete:${recordHash}`,
});

const transition = (
  currentHead: CertifiedHistoryHead<string>,
  suffix: Suffix,
) =>
  planCertifiedCatchUp({
    currentHead,
    suffix,
    sameRecordHash: (left, right) => left === right,
  });

const successfulTransition = (
  result: ReturnType<typeof transition>,
): CertifiedCatchUpPlan<string, string> =>
  Either.match(result, {
    onLeft: (error) => {
      throw error;
    },
    onRight: (plan) => plan,
  });

const failedTransition = (result: ReturnType<typeof transition>) =>
  Either.match(result, {
    onLeft: (error) => error,
    onRight: () => {
      throw new Error("Expected certified catch-up to fail");
    },
  });

const validSuffix = (
  recordHashes: readonly string[],
  firstPreviousRecordHash: string | null,
): Suffix => {
  const firstHash = recordHashes[0];
  if (firstHash === undefined) {
    throw new Error("Expected a nonempty hash fixture");
  }
  const suffix: [Envelope, ...Envelope[]] = [
    {
      recordHash: firstHash,
      previousRecordHash: firstPreviousRecordHash,
      record: `complete:${firstHash}`,
    },
  ];
  let previousRecordHash = firstHash;
  for (const recordHash of recordHashes.slice(1)) {
    suffix.push(envelope(recordHash, previousRecordHash));
    previousRecordHash = recordHash;
  }
  return suffix;
};

const validChainLaw = (
  recordHashes: readonly string[],
  hasCurrentHead: boolean,
): void => {
  const firstPreviousRecordHash = hasCurrentHead ? "head:current" : null;
  const currentHead: CertifiedHistoryHead<string> = hasCurrentHead
    ? { _tag: "certified", recordHash: "head:current" }
    : { _tag: "empty" };
  const suffix = validSuffix(recordHashes, firstPreviousRecordHash);
  const plan = successfulTransition(transition(currentHead, suffix));
  const last = suffix[suffix.length - 1];
  if (last === undefined) {
    throw new Error("Expected a nonempty suffix fixture");
  }

  expect(plan.suffix).toEqual(suffix);
  expect(plan.suffix).not.toBe(suffix);
  expect(plan.nextHead).toEqual({
    _tag: "certified",
    recordHash: last.recordHash,
  });
};

describe("planCertifiedCatchUp one-record suffix", () => {
  it("plans one genesis record from empty history", () => {
    const suffix = [envelope("record:genesis", null)] satisfies Suffix;
    const plan = successfulTransition(transition({ _tag: "empty" }, suffix));

    expect(plan).toEqual({
      suffix,
      nextHead: { _tag: "certified", recordHash: "record:genesis" },
    });
  });

  it("plans one descendant from the current certified head", () => {
    const suffix = [envelope("record:child", "record:parent")] satisfies Suffix;
    const plan = successfulTransition(
      transition({ _tag: "certified", recordHash: "record:parent" }, suffix),
    );

    expect(plan.nextHead).toEqual({
      _tag: "certified",
      recordHash: "record:child",
    });
  });
});

describe("planCertifiedCatchUp valid chains", () => {
  it("accepts every nonempty distinct chain anchored at the current head", () => {
    expect.hasAssertions();
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string(), { minLength: 1, maxLength: 50 }),
        fc.boolean(),
        validChainLaw,
      ),
    );
  });

  it("returns an independent frozen ordered suffix snapshot", () => {
    const first = {
      recordHash: "record:first",
      previousRecordHash: "record:parent",
      record: "complete:record:first",
    };
    const second = {
      recordHash: "record:second",
      previousRecordHash: "record:first",
      record: "complete:record:second",
    };
    const suffix: [typeof first, typeof second] = [first, second];
    const plan = successfulTransition(
      transition({ _tag: "certified", recordHash: "record:parent" }, suffix),
    );

    suffix.reverse();
    first.record = "mutated:first";
    second.previousRecordHash = "mutated:predecessor";

    expect(plan.suffix).toEqual([
      envelope("record:first", "record:parent"),
      envelope("record:second", "record:first"),
    ]);
    expect(Object.isFrozen(plan.suffix)).toBe(true);
    expect(plan.suffix.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(plan.nextHead)).toBe(true);
  });
});

// @agent-code-guard/regression-only: these examples distinguish the first-anchor failure from internal suffix continuity failures.
describe("planCertifiedCatchUp anchor refusal", () => {
  it("rejects a suffix anchored somewhere other than the current head", () => {
    const suffix = [
      envelope("record:first", "record:wrong-anchor"),
    ] satisfies Suffix;

    expect(
      failedTransition(
        transition({ _tag: "certified", recordHash: "record:current" }, suffix),
      ),
    ).toMatchObject({
      _tag: "CatchUpAnchorMismatchError",
      expectedPreviousRecordHash: "record:current",
      receivedPreviousRecordHash: "record:wrong-anchor",
    });
  });
});

// @agent-code-guard/regression-only: these examples pin the exact index and predecessor details for gap and reorder diagnostics.
describe("planCertifiedCatchUp continuity refusal", () => {
  it("rejects a gap inside the received suffix", () => {
    const suffix = [
      envelope("record:first", "record:parent"),
      envelope("record:second", "record:missing"),
    ] satisfies Suffix;

    expect(
      failedTransition(
        transition({ _tag: "certified", recordHash: "record:parent" }, suffix),
      ),
    ).toMatchObject({
      _tag: "CatchUpSequenceGapError",
      recordIndex: 1,
      expectedPreviousRecordHash: "record:first",
      receivedPreviousRecordHash: "record:missing",
    });
  });

  it("rejects otherwise verified records received out of order", () => {
    const first = envelope("record:first", "record:parent");
    const second = envelope("record:second", "record:first");
    const third = envelope("record:third", "record:second");
    const reordered = [first, third, second] satisfies Suffix;

    expect(
      failedTransition(
        transition(
          { _tag: "certified", recordHash: "record:parent" },
          reordered,
        ),
      ),
    ).toMatchObject({
      _tag: "CatchUpSequenceGapError",
      recordIndex: 1,
      expectedPreviousRecordHash: "record:first",
      receivedPreviousRecordHash: "record:second",
    });
  });
});

// @agent-code-guard/regression-only: this example isolates repeated identity from a predecessor gap.
describe("planCertifiedCatchUp repeated-hash refusal", () => {
  it("rejects a repeated hash even when predecessor links remain contiguous", () => {
    const suffix = [
      envelope("record:first", "record:parent"),
      envelope("record:second", "record:first"),
      envelope("record:first", "record:second"),
    ] satisfies Suffix;

    expect(
      failedTransition(
        transition({ _tag: "certified", recordHash: "record:parent" }, suffix),
      ),
    ).toMatchObject({
      _tag: "RepeatedCatchUpRecordHashError",
      firstRecordHash: "record:first",
      repeatedRecordHash: "record:first",
      firstIndex: 0,
      repeatedIndex: 2,
    });
  });
});
