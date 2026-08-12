/**
 * @file Pins fixed-membership, complete evidence retention, immutable merge,
 * and one-shot completion laws for private durability-vote progress.
 */

import { AgentId, type AgentId as AgentIdValue } from "@moltzap/identity";
import { Either, Encoding, Schema } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { InvalidMembershipSizeError } from "./durability-quorum.js";
import {
  type ConflictingDurabilityVoteEvidenceError,
  type DurabilityRecordMismatchError,
  type DurabilityVoteDisposition,
  durabilityVoteDisposition,
  type DurabilityVoteMerge,
  type DurabilityVoteProgress,
  makeDurabilityVoteProgress,
  mergeVerifiedDurabilityVote,
  type NonMemberDurabilitySignerError,
} from "./durability-vote-progress.js";

const RECORD_HASH = "record:current";
const OTHER_RECORD_HASH = "record:conflict";

interface OpaqueVoteEvidence {
  readonly fixture: string;
}

const voteEvidenceFor = (
  signerAgentId: AgentIdValue,
  variant = "verified",
): OpaqueVoteEvidence => ({
  fixture: `${signerAgentId}:${variant}`,
});

const sameVoteEvidence = (
  left: OpaqueVoteEvidence,
  right: OpaqueVoteEvidence,
): boolean => left.fixture === right.fixture;

const evidenceMapFor = (
  signerAgentIds: readonly AgentIdValue[],
): ReadonlyMap<AgentIdValue, OpaqueVoteEvidence> =>
  new Map(
    signerAgentIds.map((signerAgentId) => [
      signerAgentId,
      voteEvidenceFor(signerAgentId),
    ]),
  );

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
): DurabilityVoteProgress<string, OpaqueVoteEvidence> =>
  Either.match(
    makeDurabilityVoteProgress<string, OpaqueVoteEvidence>({
      recordHash: RECORD_HASH,
      memberAgentIds: members,
    }),
    {
      onLeft: (error) => {
        throw error;
      },
      onRight: (progress) => progress,
    },
  );

const invalidMembership = (
  members: ReadonlySet<AgentIdValue>,
): InvalidMembershipSizeError =>
  Either.match(
    makeDurabilityVoteProgress<string, OpaqueVoteEvidence>({
      recordHash: RECORD_HASH,
      memberAgentIds: members,
    }),
    {
      onLeft: (error) => error,
      onRight: () => {
        throw new Error("Expected invalid membership");
      },
    },
  );

const mergeVote = (
  progress: DurabilityVoteProgress<string, OpaqueVoteEvidence>,
  signerAgentId: AgentIdValue,
  options: {
    readonly evidence?: OpaqueVoteEvidence;
    readonly recordHash?: string;
  } = {},
) =>
  mergeVerifiedDurabilityVote({
    progress,
    vote: {
      recordHash: options.recordHash ?? RECORD_HASH,
      signerAgentId,
      evidence: options.evidence ?? voteEvidenceFor(signerAgentId),
    },
    sameRecordHash: (left, right) => left === right,
    sameVoteEvidence,
  });

const validMerge = (
  progress: DurabilityVoteProgress<string, OpaqueVoteEvidence>,
  signerAgentId: AgentIdValue,
  evidence?: OpaqueVoteEvidence,
): DurabilityVoteMerge<string, OpaqueVoteEvidence> => {
  const effectiveEvidence = evidence ?? voteEvidenceFor(signerAgentId);
  return Either.match(
    mergeVote(progress, signerAgentId, {
      evidence: effectiveEvidence,
    }),
    {
      onLeft: (error) => {
        throw error;
      },
      onRight: (merge) => merge,
    },
  );
};

const nonMemberMerge = (
  progress: DurabilityVoteProgress<string, OpaqueVoteEvidence>,
  signerAgentId: AgentIdValue,
): NonMemberDurabilitySignerError =>
  Either.match(mergeVote(progress, signerAgentId), {
    onLeft: (error) => {
      if (error._tag === "NonMemberDurabilitySignerError") {
        return error;
      }
      throw error;
    },
    onRight: () => {
      throw new Error("Expected a non-member signer failure");
    },
  });

const recordMismatch = (
  progress: DurabilityVoteProgress<string, OpaqueVoteEvidence>,
  signerAgentId: AgentIdValue,
): DurabilityRecordMismatchError<string> =>
  Either.match(
    mergeVote(progress, signerAgentId, {
      recordHash: OTHER_RECORD_HASH,
    }),
    {
      onLeft: (error) => {
        if (error._tag === "DurabilityRecordMismatchError") {
          return error;
        }
        throw error;
      },
      onRight: () => {
        throw new Error("Expected a record-binding failure");
      },
    },
  );

const conflictingEvidence = (
  progress: DurabilityVoteProgress<string, OpaqueVoteEvidence>,
  signerAgentId: AgentIdValue,
  evidence: OpaqueVoteEvidence,
): ConflictingDurabilityVoteEvidenceError<OpaqueVoteEvidence> =>
  Either.match(mergeVote(progress, signerAgentId, { evidence }), {
    onLeft: (error) => {
      if (error._tag === "ConflictingDurabilityVoteEvidenceError") {
        return error;
      }
      throw error;
    },
    onRight: () => {
      throw new Error("Expected conflicting vote evidence to fail");
    },
  });

const mergeAll = (
  initial: DurabilityVoteProgress<string, OpaqueVoteEvidence>,
  signerAgentIds: readonly AgentIdValue[],
): DurabilityVoteProgress<string, OpaqueVoteEvidence> => {
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
    expect(progress.voteEvidenceBySigner.size).toBe(0);

    input.delete(firstMember);
    input.add(laterMember);
    expect(progress.memberAgentIds).toEqual(originalInput);
    expect(progress.quorum.memberCount).toBe(originalInput.size);
  });
});

describe("mergeVerifiedDurabilityVote refusal", () => {
  it("rejects a vote bound to another record before inspecting its signer", () => {
    const members = memberSet(4);
    const signerAgentId = [...members][0];
    if (signerAgentId === undefined) {
      throw new Error("Expected a nonempty membership fixture");
    }
    const progress = validProgress(members);

    expect(recordMismatch(progress, signerAgentId)).toMatchObject({
      _tag: "DurabilityRecordMismatchError",
      expectedRecordHash: RECORD_HASH,
      receivedRecordHash: OTHER_RECORD_HASH,
    });
    expect(progress.voteEvidenceBySigner.size).toBe(0);
  });

  it("rejects a non-member with a typed error and no mutation", () => {
    const members = memberSet(4);
    const firstMember = [...members][0];
    if (firstMember === undefined) {
      throw new Error("Expected a nonempty membership fixture");
    }
    const progress = validMerge(validProgress(members), firstMember).progress;
    const memberSnapshot = new Set(progress.memberAgentIds);
    const evidenceSnapshot = new Map(progress.voteEvidenceBySigner);
    const outsider = makeAgentId(250);

    expect(nonMemberMerge(progress, outsider)).toMatchObject({
      _tag: "NonMemberDurabilitySignerError",
      signerAgentId: outsider,
    });
    expect(progress.memberAgentIds).toEqual(memberSnapshot);
    expect(progress.voteEvidenceBySigner).toEqual(evidenceSnapshot);
  });
});

describe("mergeVerifiedDurabilityVote conflict handling", () => {
  it("rejects differing evidence from an existing signer", () => {
    const members = memberSet(4);
    const signerAgentId = [...members][0];
    if (signerAgentId === undefined) {
      throw new Error("Expected a nonempty membership fixture");
    }
    const acceptedEvidence = voteEvidenceFor(signerAgentId, "accepted");
    const receivedEvidence = voteEvidenceFor(signerAgentId, "conflict");
    const progress = validMerge(
      validProgress(members),
      signerAgentId,
      acceptedEvidence,
    ).progress;
    const evidenceSnapshot = new Map(progress.voteEvidenceBySigner);

    expect(
      conflictingEvidence(progress, signerAgentId, receivedEvidence),
    ).toMatchObject({
      _tag: "ConflictingDurabilityVoteEvidenceError",
      signerAgentId,
      existingEvidence: acceptedEvidence,
      receivedEvidence,
    });
    expect(progress.voteEvidenceBySigner).toEqual(evidenceSnapshot);
  });
});

describe("mergeVerifiedDurabilityVote duplicate handling", () => {
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
    const firstEvidence = voteEvidenceFor(firstMember);
    const duplicateEvidence = voteEvidenceFor(firstMember);
    expect(duplicateEvidence).not.toBe(firstEvidence);
    const first = validMerge(initial, firstMember, firstEvidence);
    const duplicateBefore = validMerge(
      first.progress,
      firstMember,
      duplicateEvidence,
    );
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

describe("mergeVerifiedDurabilityVote immutability", () => {
  it("leaves membership and prior evidence unchanged when a new vote is accepted", () => {
    const members = memberSet(7);
    const signerAgentId = [...members][0];
    if (signerAgentId === undefined) {
      throw new Error("Expected a nonempty membership fixture");
    }
    const progress = validProgress(members);
    const memberSnapshot = new Set(progress.memberAgentIds);
    const evidenceSnapshot = new Map(progress.voteEvidenceBySigner);
    const evidence = voteEvidenceFor(signerAgentId);
    const merge = validMerge(progress, signerAgentId, evidence);

    expect(progress.memberAgentIds).toEqual(memberSnapshot);
    expect(progress.voteEvidenceBySigner).toEqual(evidenceSnapshot);
    expect(merge.progress.memberAgentIds).toBe(progress.memberAgentIds);
    expect(merge.progress.voteEvidenceBySigner).not.toBe(
      progress.voteEvidenceBySigner,
    );
    expect(merge.progress.voteEvidenceBySigner).toEqual(
      new Map([[signerAgentId, evidence]]),
    );
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
          const signerCountBefore = progress.voteEvidenceBySigner.size;
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
        expect(progress.voteEvidenceBySigner).toEqual(evidenceMapFor(members));
      }),
    );
  });
});

describe("durability vote progress order law", () => {
  it("produces the same complete evidence regardless of arrival order", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (memberCount) => {
        const members = [...memberSet(memberCount)];
        const initial = validProgress(new Set(members));
        const forward = mergeAll(initial, members);
        const reverse = mergeAll(initial, [...members].reverse());

        expect(forward.memberAgentIds).toEqual(reverse.memberAgentIds);
        expect(forward.voteEvidenceBySigner).toEqual(
          reverse.voteEvidenceBySigner,
        );
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
