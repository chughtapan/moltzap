/**
 * @file Pins stable-body binding, complete evidence retention, immutable
 * merging, and one-shot completion for private Router re-anchor votes.
 */

import { AgentId, type AgentId as AgentIdValue } from "@moltzap/identity";
import { Either, Encoding, Schema } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { InvalidMembershipSizeError } from "./durability-quorum.js";
import {
  type ConflictingReanchorVoteEvidenceError,
  makeReanchorVoteProgress,
  mergeVerifiedReanchorVote,
  type NonMemberReanchorSignerError,
  type ReanchorBodyMismatchError,
  reanchorVoteDisposition,
  type ReanchorVoteMerge,
  type ReanchorVoteProgress,
} from "./reanchor-vote-progress.js";

const BODY_HASH = "anchor-body:current";
const OTHER_BODY_HASH = "anchor-body:conflict";

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

const evidenceMapFor = (
  signerAgentIds: readonly AgentIdValue[],
): ReadonlyMap<AgentIdValue, OpaqueVoteEvidence> => {
  const evidenceBySigner = new Map<AgentIdValue, OpaqueVoteEvidence>();
  for (const signerAgentId of signerAgentIds) {
    evidenceBySigner.set(signerAgentId, voteEvidenceFor(signerAgentId));
  }
  return evidenceBySigner;
};

const validProgress = (
  members: ReadonlySet<AgentIdValue>,
): ReanchorVoteProgress<string, OpaqueVoteEvidence> =>
  Either.match(
    makeReanchorVoteProgress<string, OpaqueVoteEvidence>({
      bodyHash: BODY_HASH,
      memberAgentIds: members,
    }),
    {
      onLeft: (error) => {
        throw error;
      },
      onRight: (progress) => progress,
    },
  );

const invalidMembership = (): InvalidMembershipSizeError =>
  Either.match(
    makeReanchorVoteProgress<string, OpaqueVoteEvidence>({
      bodyHash: BODY_HASH,
      memberAgentIds: new Set<AgentIdValue>(),
    }),
    {
      onLeft: (error) => error,
      onRight: () => {
        throw new Error("Expected invalid membership");
      },
    },
  );

const mergeVote = (
  progress: ReanchorVoteProgress<string, OpaqueVoteEvidence>,
  signerAgentId: AgentIdValue,
  options: {
    readonly bodyHash?: string;
    readonly evidence?: OpaqueVoteEvidence;
  } = {},
) =>
  mergeVerifiedReanchorVote({
    progress,
    vote: {
      bodyHash: options.bodyHash ?? BODY_HASH,
      signerAgentId,
      evidence: options.evidence ?? voteEvidenceFor(signerAgentId),
    },
    sameBodyHash: (left, right) => left === right,
    sameVoteEvidence,
  });

const validMerge = (
  progress: ReanchorVoteProgress<string, OpaqueVoteEvidence>,
  signerAgentId: AgentIdValue,
  evidence?: OpaqueVoteEvidence,
): ReanchorVoteMerge<string, OpaqueVoteEvidence> => {
  const effectiveEvidence = evidence ?? voteEvidenceFor(signerAgentId);
  return Either.match(
    mergeVote(progress, signerAgentId, { evidence: effectiveEvidence }),
    {
      onLeft: (error) => {
        throw error;
      },
      onRight: (merge) => merge,
    },
  );
};

type VoteFailure =
  | ConflictingReanchorVoteEvidenceError<OpaqueVoteEvidence>
  | NonMemberReanchorSignerError
  | ReanchorBodyMismatchError<string>;

const failedMerge = (
  progress: ReanchorVoteProgress<string, OpaqueVoteEvidence>,
  signerAgentId: AgentIdValue,
  options: {
    readonly bodyHash?: string;
    readonly evidence?: OpaqueVoteEvidence;
  } = {},
): VoteFailure =>
  Either.match(mergeVote(progress, signerAgentId, options), {
    onLeft: (error) => error,
    onRight: () => {
      throw new Error("Expected re-anchor vote merge to fail");
    },
  });

const mergeAll = (
  initial: ReanchorVoteProgress<string, OpaqueVoteEvidence>,
  signerAgentIds: readonly AgentIdValue[],
): ReanchorVoteProgress<string, OpaqueVoteEvidence> => {
  let progress = initial;
  for (const signerAgentId of signerAgentIds) {
    progress = validMerge(progress, signerAgentId).progress;
  }
  return progress;
};

describe("makeReanchorVoteProgress", () => {
  it("rejects empty membership through the shared quorum profile", () => {
    expect(invalidMembership()).toMatchObject({
      _tag: "InvalidMembershipSizeError",
      memberCount: 0,
    });
  });

  it("captures membership without retaining the caller's mutable set", () => {
    const firstMember = makeAgentId(1);
    const secondMember = makeAgentId(2);
    const laterMember = makeAgentId(3);
    const input = new Set([firstMember, secondMember]);
    const progress = validProgress(input);

    input.delete(firstMember);
    input.add(laterMember);

    expect(progress.bodyHash).toBe(BODY_HASH);
    expect(new Set(progress.memberAgentIds)).toEqual(
      new Set([firstMember, secondMember]),
    );
    expect(progress.voteEvidenceBySigner.size).toBe(0);
  });
});

describe("mergeVerifiedReanchorVote refusal", () => {
  it("rejects another body before inspecting an outsider signer", () => {
    const progress = validProgress(memberSet(4));
    const outsider = makeAgentId(250);

    expect(
      failedMerge(progress, outsider, { bodyHash: OTHER_BODY_HASH }),
    ).toMatchObject({
      _tag: "ReanchorBodyMismatchError",
      expectedBodyHash: BODY_HASH,
      receivedBodyHash: OTHER_BODY_HASH,
    });
    expect(progress.voteEvidenceBySigner.size).toBe(0);
  });

  it("rejects a verified non-member without mutating progress", () => {
    const members = memberSet(4);
    const firstMember = [...members][0];
    if (firstMember === undefined) {
      throw new Error("Expected a nonempty membership fixture");
    }
    const progress = validMerge(validProgress(members), firstMember).progress;
    const evidenceSnapshot = new Map(progress.voteEvidenceBySigner);
    const outsider = makeAgentId(250);

    expect(failedMerge(progress, outsider)).toMatchObject({
      _tag: "NonMemberReanchorSignerError",
      signerAgentId: outsider,
    });
    expect(new Map(progress.voteEvidenceBySigner)).toEqual(evidenceSnapshot);
  });
});

describe("mergeVerifiedReanchorVote conflict handling", () => {
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
      failedMerge(progress, signerAgentId, { evidence: receivedEvidence }),
    ).toMatchObject({
      _tag: "ConflictingReanchorVoteEvidenceError",
      signerAgentId,
      existingEvidence: acceptedEvidence,
      receivedEvidence,
    });
    expect(new Map(progress.voteEvidenceBySigner)).toEqual(evidenceSnapshot);
  });
});

describe("mergeVerifiedReanchorVote duplicate handling", () => {
  it("keeps equal duplicates harmless and later votes as enrichment", () => {
    const [first, second, third, fourth] = [...memberSet(4)];
    if (
      first === undefined ||
      second === undefined ||
      third === undefined ||
      fourth === undefined
    ) {
      throw new Error("Expected four membership fixtures");
    }
    const firstEvidence = voteEvidenceFor(first);
    const equalEvidence = voteEvidenceFor(first);
    const initial = validProgress(new Set([first, second, third, fourth]));
    const accepted = validMerge(initial, first, firstEvidence);
    const duplicate = validMerge(accepted.progress, first, equalEvidence);
    const collecting = validMerge(duplicate.progress, second);
    const completed = validMerge(collecting.progress, third);
    const enriched = validMerge(completed.progress, fourth);

    expect(equalEvidence).not.toBe(firstEvidence);
    expect(duplicate).toEqual({
      progress: accepted.progress,
      disposition: reanchorVoteDisposition.duplicate,
      newlyCompleted: false,
    });
    expect(completed.newlyCompleted).toBe(true);
    expect(enriched.disposition).toBe(reanchorVoteDisposition.enriched);
  });
});

describe("mergeVerifiedReanchorVote immutability", () => {
  it("copies the evidence map when accepting a new vote", () => {
    const members = memberSet(4);
    const signerAgentId = [...members][0];
    if (signerAgentId === undefined) {
      throw new Error("Expected a nonempty membership fixture");
    }
    const progress = validProgress(members);
    const evidenceSnapshot = new Map(progress.voteEvidenceBySigner);
    const evidence = voteEvidenceFor(signerAgentId);
    const merge = validMerge(progress, signerAgentId, evidence);

    expect(new Map(progress.voteEvidenceBySigner)).toEqual(evidenceSnapshot);
    expect(merge.progress.memberAgentIds).toBe(progress.memberAgentIds);
    expect(merge.progress.voteEvidenceBySigner).not.toBe(
      progress.voteEvidenceBySigner,
    );
    expect(new Map(merge.progress.voteEvidenceBySigner)).toEqual(
      new Map([[signerAgentId, evidence]]),
    );
    for (const name of ["add", "delete", "clear"]) {
      expect(Reflect.get(progress.memberAgentIds, name)).toBeUndefined();
    }
    for (const evidenceView of [
      progress.voteEvidenceBySigner,
      merge.progress.voteEvidenceBySigner,
    ]) {
      for (const name of ["set", "delete", "clear"]) {
        expect(Reflect.get(evidenceView, name)).toBeUndefined();
      }
    }
    expect(progress.voteEvidenceBySigner.size).toBe(0);
  });
});

describe("re-anchor vote completion law", () => {
  it("completes exactly once at every fixed-membership threshold", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (memberCount) => {
        const members = [...memberSet(memberCount)];
        let progress = validProgress(new Set(members));
        let completionCount = 0;

        for (const signerAgentId of members) {
          const merge = validMerge(progress, signerAgentId);
          if (merge.newlyCompleted) {
            completionCount += 1;
            expect(merge.disposition).toBe(reanchorVoteDisposition.completed);
          }
          progress = merge.progress;
        }

        expect(completionCount).toBe(1);
        expect(new Map(progress.voteEvidenceBySigner)).toEqual(
          evidenceMapFor(members),
        );
      }),
    );
  });
});

describe("re-anchor vote order law", () => {
  it("produces the same complete evidence in either arrival order", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (memberCount) => {
        const members = [...memberSet(memberCount)];
        const initial = validProgress(new Set(members));
        const forward = mergeAll(initial, members);
        const reverse = mergeAll(initial, [...members].reverse());

        expect(new Set(forward.memberAgentIds)).toEqual(
          new Set(reverse.memberAgentIds),
        );
        expect(new Map(forward.voteEvidenceBySigner)).toEqual(
          new Map(reverse.voteEvidenceBySigner),
        );
        expect(forward.quorum).toEqual(reverse.quorum);
      }),
    );
  });
});
