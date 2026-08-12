/**
 * @file Pins predecessor, record-binding, and threshold gates for atomic
 * promotion from staged material to one certified-history head.
 */

import { AgentId, type AgentId as AgentIdValue } from "@moltzap/identity";
import { Either, Encoding, Schema } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type CertifiedHeadAdvance,
  type CertifiedHistoryHead,
  planCertifiedHeadAdvance,
  type StagedActionCertifiedRecord,
} from "./certified-head-advance.js";
import {
  type DurabilityVoteProgress,
  makeDurabilityVoteProgress,
  mergeVerifiedDurabilityVote,
} from "./durability-vote-progress.js";

const GENESIS_HASH = "record:genesis";
const NEXT_HASH = "record:next";

const makeAgentId = (seed: number): AgentIdValue =>
  Schema.decodeUnknownSync(AgentId)(
    `agt_${Encoding.encodeBase64Url(new Uint8Array(16).fill(seed))}`,
  );

const membersFor = (memberCount: number): readonly AgentIdValue[] => {
  const members: AgentIdValue[] = [];
  for (let index = 0; index < memberCount; index += 1) {
    members.push(makeAgentId(index));
  }
  return members;
};

const emptyProgress = (
  recordHash: string,
  members: readonly AgentIdValue[],
): DurabilityVoteProgress<string> =>
  Either.match(
    makeDurabilityVoteProgress({
      recordHash,
      memberAgentIds: new Set(members),
    }),
    {
      onLeft: (error) => {
        throw error;
      },
      onRight: (progress) => progress,
    },
  );

const addSigners = (
  progress: DurabilityVoteProgress<string>,
  signers: readonly AgentIdValue[],
): DurabilityVoteProgress<string> => {
  let current = progress;
  for (const signerAgentId of signers) {
    current = Either.match(
      mergeVerifiedDurabilityVote({
        progress: current,
        vote: { recordHash: current.recordHash, signerAgentId },
        sameRecordHash: (left, right) => left === right,
      }),
      {
        onLeft: (error) => {
          throw error;
        },
        onRight: (merge) => merge.progress,
      },
    );
  }
  return current;
};

const stage = (
  recordHash: string,
  previousRecordHash: string | null,
): StagedActionCertifiedRecord<string, { readonly content: string }> => ({
  recordHash,
  previousRecordHash,
  record: { content: `content:${recordHash}` },
});

const transition = (input: {
  readonly currentHead: CertifiedHistoryHead<string>;
  readonly staged: StagedActionCertifiedRecord<
    string,
    { readonly content: string }
  >;
  readonly voteProgress: DurabilityVoteProgress<string>;
}) =>
  planCertifiedHeadAdvance({
    ...input,
    sameRecordHash: (left, right) => left === right,
  });

const successfulTransition = (
  result: ReturnType<typeof transition>,
): CertifiedHeadAdvance<string, { readonly content: string }> =>
  Either.match(result, {
    onLeft: (error) => {
      throw error;
    },
    onRight: (advance) => advance,
  });

const failedTransition = (result: ReturnType<typeof transition>) =>
  Either.match(result, {
    onLeft: (error) => error,
    onRight: () => {
      throw new Error("Expected certified-head advance to fail");
    },
  });

describe("planCertifiedHeadAdvance binding", () => {
  it("rejects durability progress for a different staged record", () => {
    const members = membersFor(4);
    const progress = addSigners(
      emptyProgress(NEXT_HASH, members),
      members.slice(0, 3),
    );

    expect(
      failedTransition(
        transition({
          currentHead: { _tag: "empty" },
          staged: stage(GENESIS_HASH, null),
          voteProgress: progress,
        }),
      ),
    ).toMatchObject({
      _tag: "StagedRecordVoteMismatchError",
      stagedRecordHash: GENESIS_HASH,
      voteRecordHash: NEXT_HASH,
    });
  });
});

describe("planCertifiedHeadAdvance predecessor", () => {
  it.each([
    {
      currentHead: { _tag: "empty" } as const,
      previousRecordHash: GENESIS_HASH,
      expectedPreviousRecordHash: null,
    },
    {
      currentHead: {
        _tag: "certified" as const,
        recordHash: GENESIS_HASH,
      },
      previousRecordHash: null,
      expectedPreviousRecordHash: GENESIS_HASH,
    },
    {
      currentHead: {
        _tag: "certified" as const,
        recordHash: GENESIS_HASH,
      },
      previousRecordHash: "record:stale",
      expectedPreviousRecordHash: GENESIS_HASH,
    },
  ])(
    "rejects a non-extending predecessor: $previousRecordHash",
    ({ currentHead, previousRecordHash, expectedPreviousRecordHash }) => {
      const members = membersFor(1);
      const progress = addSigners(emptyProgress(NEXT_HASH, members), members);

      expect(
        failedTransition(
          transition({
            currentHead,
            staged: stage(NEXT_HASH, previousRecordHash),
            voteProgress: progress,
          }),
        ),
      ).toMatchObject({
        _tag: "CertifiedPredecessorMismatchError",
        expectedPreviousRecordHash,
        receivedPreviousRecordHash: previousRecordHash,
      });
    },
  );
});

describe("planCertifiedHeadAdvance incomplete threshold", () => {
  it("rejects one signer below every fixed-membership threshold", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (memberCount) => {
        const members = membersFor(memberCount);
        const initial = emptyProgress(GENESIS_HASH, members);
        const progress = addSigners(
          initial,
          members.slice(0, initial.quorum.requiredVotes - 1),
        );

        expect(
          failedTransition(
            transition({
              currentHead: { _tag: "empty" },
              staged: stage(GENESIS_HASH, null),
              voteProgress: progress,
            }),
          ),
        ).toMatchObject({
          _tag: "IncompleteDurabilityEvidenceError",
          signerCount: initial.quorum.requiredVotes - 1,
          requiredVotes: initial.quorum.requiredVotes,
        });
      }),
    );
  });
});

describe("planCertifiedHeadAdvance completed threshold", () => {
  it("plans exactly the verified descendant at every threshold", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (memberCount) => {
        const members = membersFor(memberCount);
        const initial = emptyProgress(NEXT_HASH, members);
        const progress = addSigners(
          initial,
          members.slice(0, initial.quorum.requiredVotes),
        );
        const staged = stage(NEXT_HASH, GENESIS_HASH);
        const advance = successfulTransition(
          transition({
            currentHead: {
              _tag: "certified",
              recordHash: GENESIS_HASH,
            },
            staged,
            voteProgress: progress,
          }),
        );

        expect(advance).toEqual({
          staged,
          nextHead: { _tag: "certified", recordHash: NEXT_HASH },
        });
        expect(advance.staged).not.toBe(staged);
        expect(Object.isFrozen(advance.staged)).toBe(true);
        expect(Object.isFrozen(advance.nextHead)).toBe(true);
      }),
    );
  });
});
