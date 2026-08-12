/**
 * @file Pins durability arithmetic, small-membership unanimity, and quorum
 * intersection safety behind the private harness boundary.
 */

import { Either } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  durabilityQuorum,
  type DurabilityQuorum,
  type InvalidMembershipSizeError,
  meetsDurabilityThreshold,
} from "./durability-quorum.js";

const validQuorum = (memberCount: number): DurabilityQuorum =>
  Either.match(durabilityQuorum(memberCount), {
    onLeft: (error) => {
      throw error;
    },
    onRight: (quorum) => quorum,
  });

const invalidSize = (memberCount: number): InvalidMembershipSizeError =>
  Either.match(durabilityQuorum(memberCount), {
    onLeft: (error) => error,
    onRight: () => {
      throw new Error(`Expected invalid membership size: ${memberCount}`);
    },
  });

describe("durabilityQuorum exact profiles", () => {
  it.each([
    [1, 0, 1, 1],
    [2, 0, 2, 2],
    [3, 0, 3, 3],
    [4, 1, 3, 2],
    [5, 1, 4, 3],
    [6, 1, 5, 4],
    [7, 2, 5, 3],
    [8, 2, 6, 4],
    [9, 2, 7, 5],
    [10, 3, 7, 4],
  ])(
    "computes n=%i with f=%i, threshold=%i, and honest floor=%i",
    (memberCount, byzantineBound, requiredVotes, honestReplicaFloor) => {
      expect(validQuorum(memberCount)).toEqual({
        memberCount,
        byzantineBound,
        requiredVotes,
        honestStagedReplicaFloor: honestReplicaFloor,
      });
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid membership size %s",
    (memberCount) => {
      expect(invalidSize(memberCount)).toMatchObject({
        _tag: "InvalidMembershipSizeError",
        memberCount,
      });
    },
  );
});

describe("durabilityQuorum safety laws", () => {
  it("requires unanimity below four members", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 3 }), (memberCount) => {
        const quorum = validQuorum(memberCount);
        expect(quorum.requiredVotes).toBe(memberCount);
        expect(quorum.byzantineBound).toBe(0);
        expect(quorum.honestStagedReplicaFloor).toBe(memberCount);
      }),
    );
  });

  it("keeps completed large quorums intersecting in an honest member", () => {
    fc.assert(
      fc.property(fc.integer({ min: 4, max: 10_000 }), (memberCount) => {
        const quorum = validQuorum(memberCount);
        const minimumIntersection =
          2 * quorum.requiredVotes - quorum.memberCount;

        expect(quorum.requiredVotes).toBe(memberCount - quorum.byzantineBound);
        expect(minimumIntersection).toBeGreaterThan(quorum.byzantineBound);
        expect(quorum.honestStagedReplicaFloor).toBe(
          memberCount - 2 * quorum.byzantineBound,
        );
      }),
    );
  });
});

describe("meetsDurabilityThreshold", () => {
  it("accepts only bounded safe-integer counts at or above the threshold", () => {
    const quorum = validQuorum(7);
    expect(meetsDurabilityThreshold(quorum, 4)).toBe(false);
    expect(meetsDurabilityThreshold(quorum, 5)).toBe(true);
    expect(meetsDurabilityThreshold(quorum, 7)).toBe(true);
    expect(meetsDurabilityThreshold(quorum, 8)).toBe(false);
    expect(meetsDurabilityThreshold(quorum, 5.5)).toBe(false);
  });
});
