/**
 * @file Pins fixed-membership, immutable merge, and one-shot completion laws
 * for private durability signer progress.
 */

import { AgentId, type AgentId as AgentIdValue } from "@moltzap/identity";
import { Either, Encoding, Schema } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { InvalidMembershipSizeError } from "./durability-quorum.js";
import {
  type DurabilityVoteDisposition,
  durabilityVoteDisposition,
  type DurabilityVoteMerge,
  type DurabilityVoteProgress,
  makeDurabilityVoteProgress,
  mergeVerifiedDurabilitySigner,
  type NonMemberDurabilitySignerError,
} from "./durability-vote-progress.js";

const makeAgentId = (seed: number): AgentIdValue =>
  Schema.decodeUnknownSync(AgentId)(
    `agt_${Encoding.encodeBase64Url(new Uint8Array(16).fill(seed))}`,
  );

const memberSet = (memberCount: number): ReadonlySet<AgentIdValue> => {
  const members = new Set<AgentIdValue>();
  for (let seed = 0; seed < memberCount; seed += 1) {
    members.add(makeAgentId(seed));
  }
  return members;
};

const validProgress = (
  members: ReadonlySet<AgentIdValue>,
): DurabilityVoteProgress =>
  Either.match(makeDurabilityVoteProgress(members), {
    onLeft: (error) => {
      throw error;
    },
    onRight: (progress) => progress,
  });

const invalidMembership = (
  members: ReadonlySet<AgentIdValue>,
): InvalidMembershipSizeError =>
  Either.match(makeDurabilityVoteProgress(members), {
    onLeft: (error) => error,
    onRight: () => {
      throw new Error("Expected invalid membership");
    },
  });

const validMerge = (
  progress: DurabilityVoteProgress,
  signerAgentId: AgentIdValue,
): DurabilityVoteMerge =>
  Either.match(mergeVerifiedDurabilitySigner(progress, signerAgentId), {
    onLeft: (error) => {
      throw error;
    },
    onRight: (merge) => merge,
  });

const nonMemberMerge = (
  progress: DurabilityVoteProgress,
  signerAgentId: AgentIdValue,
): NonMemberDurabilitySignerError =>
  Either.match(mergeVerifiedDurabilitySigner(progress, signerAgentId), {
    onLeft: (error) => error,
    onRight: () => {
      throw new Error("Expected a non-member signer failure");
    },
  });

const mergeAll = (
  initial: DurabilityVoteProgress,
  signerAgentIds: readonly AgentIdValue[],
): DurabilityVoteProgress => {
  let progress = initial;
  for (const signerAgentId of signerAgentIds) {
    progress = validMerge(progress, signerAgentId).progress;
  }
  return progress;
};

const expectedDispositionAfterAdding = (
  signerCountBefore: number,
  requiredVotes: number,
): DurabilityVoteDisposition => {
  const signerCountAfter = signerCountBefore + 1;
  if (signerCountAfter < requiredVotes) {
    return durabilityVoteDisposition.collecting;
  }
  if (signerCountAfter === requiredVotes) {
    return durabilityVoteDisposition.completed;
  }
  return durabilityVoteDisposition.enriched;
};

describe("makeDurabilityVoteProgress", () => {
  it("rejects an empty fixed membership through the quorum error", () => {
    expect(invalidMembership(new Set())).toMatchObject({
      _tag: "InvalidMembershipSizeError",
      memberCount: 0,
    });
  });

  it("captures membership without changing or retaining the input set", () => {
    const firstMember = makeAgentId(1);
    const secondMember = makeAgentId(2);
    const laterMember = makeAgentId(3);
    const input = new Set([firstMember, secondMember]);
    const originalInput = new Set(input);
    const progress = validProgress(input);

    expect(input).toEqual(originalInput);
    expect(progress.memberAgentIds).not.toBe(input);
    expect(progress.memberAgentIds).toEqual(originalInput);
    expect(progress.signerAgentIds.size).toBe(0);

    input.delete(firstMember);
    input.add(laterMember);
    expect(progress.memberAgentIds).toEqual(originalInput);
    expect(progress.quorum.memberCount).toBe(originalInput.size);
  });
});

describe("mergeVerifiedDurabilitySigner non-member handling", () => {
  it("rejects a non-member with a typed error and no mutation", () => {
    const members = memberSet(4);
    const firstMember = [...members][0];
    if (firstMember === undefined) {
      throw new Error("Expected a nonempty membership fixture");
    }
    const progress = validMerge(validProgress(members), firstMember).progress;
    const memberSnapshot = new Set(progress.memberAgentIds);
    const signerSnapshot = new Set(progress.signerAgentIds);
    const outsider = makeAgentId(250);

    expect(nonMemberMerge(progress, outsider)).toMatchObject({
      _tag: "NonMemberDurabilitySignerError",
      signerAgentId: outsider,
    });
    expect(progress.memberAgentIds).toEqual(memberSnapshot);
    expect(progress.signerAgentIds).toEqual(signerSnapshot);
  });
});

describe("mergeVerifiedDurabilitySigner duplicate handling", () => {
  it("makes duplicates harmless before and after completion", () => {
    const members = [...memberSet(4)];
    const [firstMember, secondMember, thirdMember, fourthMember] = members;
    if (
      firstMember === undefined ||
      secondMember === undefined ||
      thirdMember === undefined ||
      fourthMember === undefined
    ) {
      throw new Error("Expected four membership fixtures");
    }
    const initial = validProgress(new Set(members));
    const first = validMerge(initial, firstMember);
    const duplicateBefore = validMerge(first.progress, firstMember);
    const second = validMerge(duplicateBefore.progress, secondMember);
    const completion = validMerge(second.progress, thirdMember);
    const duplicateAfter = validMerge(completion.progress, thirdMember);
    const enrichment = validMerge(duplicateAfter.progress, fourthMember);
    const duplicateEnrichment = validMerge(enrichment.progress, fourthMember);

    expect(duplicateBefore).toEqual({
      progress: first.progress,
      disposition: durabilityVoteDisposition.duplicate,
      newlyCompleted: false,
    });
    expect(completion.disposition).toBe(durabilityVoteDisposition.completed);
    expect(completion.newlyCompleted).toBe(true);
    expect(duplicateAfter).toEqual({
      progress: completion.progress,
      disposition: durabilityVoteDisposition.duplicate,
      newlyCompleted: false,
    });
    expect(enrichment.disposition).toBe(durabilityVoteDisposition.enriched);
    expect(enrichment.newlyCompleted).toBe(false);
    expect(duplicateEnrichment).toEqual({
      progress: enrichment.progress,
      disposition: durabilityVoteDisposition.duplicate,
      newlyCompleted: false,
    });
  });
});

describe("mergeVerifiedDurabilitySigner immutability", () => {
  it("leaves every input set unchanged when a new signer is accepted", () => {
    const members = memberSet(7);
    const signerAgentId = [...members][0];
    if (signerAgentId === undefined) {
      throw new Error("Expected a nonempty membership fixture");
    }
    const progress = validProgress(members);
    const memberSnapshot = new Set(progress.memberAgentIds);
    const signerSnapshot = new Set(progress.signerAgentIds);
    const merge = validMerge(progress, signerAgentId);

    expect(progress.memberAgentIds).toEqual(memberSnapshot);
    expect(progress.signerAgentIds).toEqual(signerSnapshot);
    expect(merge.progress.memberAgentIds).toBe(progress.memberAgentIds);
    expect(merge.progress.signerAgentIds).not.toBe(progress.signerAgentIds);
    expect(merge.progress.signerAgentIds).toEqual(new Set([signerAgentId]));
  });
});

describe("durability vote progress completion law", () => {
  it("counts each threshold transition exactly once for every profile", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (memberCount) => {
        const members = [...memberSet(memberCount)];
        let progress = validProgress(new Set(members));
        let completionCount = 0;

        for (const signerAgentId of members) {
          const signerCountBefore = progress.signerAgentIds.size;
          const merge = validMerge(progress, signerAgentId);
          const expectedDisposition = expectedDispositionAfterAdding(
            signerCountBefore,
            progress.quorum.requiredVotes,
          );

          expect(merge.disposition).toBe(expectedDisposition);
          if (merge.newlyCompleted) {
            completionCount += 1;
          }
          progress = merge.progress;
        }

        expect(completionCount).toBe(1);
        expect(progress.signerAgentIds).toEqual(new Set(members));
      }),
    );
  });
});

describe("durability vote progress order law", () => {
  it("produces the same signer progress regardless of arrival order", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (memberCount) => {
        const members = [...memberSet(memberCount)];
        const initial = validProgress(new Set(members));
        const forward = mergeAll(initial, members);
        const reverse = mergeAll(initial, [...members].reverse());

        expect(forward.memberAgentIds).toEqual(reverse.memberAgentIds);
        expect(forward.signerAgentIds).toEqual(reverse.signerAgentIds);
        expect(forward.quorum).toEqual(reverse.quorum);
      }),
    );
  });
});

describe("durability vote progress duplicate law", () => {
  it("keeps every duplicate harmless for every completed profile", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (memberCount) => {
        const members = [...memberSet(memberCount)];
        const complete = mergeAll(validProgress(new Set(members)), members);

        for (const signerAgentId of members) {
          const duplicate = validMerge(complete, signerAgentId);
          expect(duplicate.progress).toBe(complete);
          expect(duplicate.disposition).toBe(
            durabilityVoteDisposition.duplicate,
          );
          expect(duplicate.newlyCompleted).toBe(false);
        }
      }),
    );
  });
});
