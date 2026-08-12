/**
 * @file Pins stable-body binding, fixed membership, immutable merging, and
 * one-shot threshold completion for private Router re-anchor vote progress.
 */

import { AgentId, type AgentId as AgentIdValue } from "@moltzap/identity";
import { Either, Encoding, Schema } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { InvalidMembershipSizeError } from "./durability-quorum.js";
import {
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
): ReanchorVoteProgress<string> =>
  Either.match(
    makeReanchorVoteProgress({
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
    makeReanchorVoteProgress({
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
  progress: ReanchorVoteProgress<string>,
  signerAgentId: AgentIdValue,
  bodyHash = BODY_HASH,
): Either.Either<
  ReanchorVoteMerge<string>,
  ReanchorBodyMismatchError<string> | NonMemberReanchorSignerError
> =>
  mergeVerifiedReanchorVote({
    progress,
    vote: { bodyHash, signerAgentId },
    sameBodyHash: (left, right) => left === right,
  });

const validMerge = (
  progress: ReanchorVoteProgress<string>,
  signerAgentId: AgentIdValue,
): ReanchorVoteMerge<string> =>
  Either.match(mergeVote(progress, signerAgentId), {
    onLeft: (error) => {
      throw error;
    },
    onRight: (merge) => merge,
  });

const failedMerge = (
  progress: ReanchorVoteProgress<string>,
  signerAgentId: AgentIdValue,
  bodyHash = BODY_HASH,
): ReanchorBodyMismatchError<string> | NonMemberReanchorSignerError =>
  Either.match(mergeVote(progress, signerAgentId, bodyHash), {
    onLeft: (error) => error,
    onRight: () => {
      throw new Error("Expected re-anchor vote merge to fail");
    },
  });

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
    expect(progress.memberAgentIds).toEqual(
      new Set([firstMember, secondMember]),
    );
    expect(progress.signerAgentIds.size).toBe(0);
  });
});

describe("mergeVerifiedReanchorVote refusal", () => {
  it("rejects a different stable body before inspecting its signer", () => {
    const members = memberSet(4);
    const signerAgentId = [...members][0];
    if (signerAgentId === undefined) {
      throw new Error("Expected a nonempty membership fixture");
    }
    const progress = validProgress(members);

    expect(failedMerge(progress, signerAgentId, OTHER_BODY_HASH)).toMatchObject(
      {
        _tag: "ReanchorBodyMismatchError",
        expectedBodyHash: BODY_HASH,
        receivedBodyHash: OTHER_BODY_HASH,
      },
    );
    expect(progress.signerAgentIds.size).toBe(0);
  });

  it("rejects a verified non-member without mutating progress", () => {
    const progress = validProgress(memberSet(4));
    const outsider = makeAgentId(250);

    expect(failedMerge(progress, outsider)).toMatchObject({
      _tag: "NonMemberReanchorSignerError",
      signerAgentId: outsider,
    });
    expect(progress.signerAgentIds.size).toBe(0);
  });
});

describe("mergeVerifiedReanchorVote threshold", () => {
  it("completes exactly once at the shared threshold for every profile", () => {
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
        expect(progress.signerAgentIds).toEqual(new Set(members));
      }),
    );
  });
});

describe("mergeVerifiedReanchorVote duplicate handling", () => {
  it("treats duplicates as harmless and later new votes as enrichment", () => {
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
    const first = validMerge(validProgress(new Set(members)), firstMember);
    const duplicate = validMerge(first.progress, firstMember);
    const second = validMerge(duplicate.progress, secondMember);
    const completion = validMerge(second.progress, thirdMember);
    const enrichment = validMerge(completion.progress, fourthMember);

    expect(duplicate).toEqual({
      progress: first.progress,
      disposition: reanchorVoteDisposition.duplicate,
      newlyCompleted: false,
    });
    expect(completion.newlyCompleted).toBe(true);
    expect(enrichment).toMatchObject({
      disposition: reanchorVoteDisposition.enriched,
      newlyCompleted: false,
    });
  });
});

describe("mergeVerifiedReanchorVote order law", () => {
  it("produces the same signer map regardless of vote arrival order", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (memberCount) => {
        const members = [...memberSet(memberCount)];
        const initial = validProgress(new Set(members));
        const mergeAll = (order: readonly AgentIdValue[]) => {
          let progress = initial;
          for (const signerAgentId of order) {
            progress = validMerge(progress, signerAgentId).progress;
          }
          return progress;
        };

        expect(mergeAll(members).signerAgentIds).toEqual(
          mergeAll([...members].reverse()).signerAgentIds,
        );
      }),
    );
  });
});
