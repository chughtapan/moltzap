/**
 * @file Pins atomic certified-head promotion and evidence-only enrichment.
 */

import { AgentId, type AgentId as AgentIdValue } from "@moltzap/identity";
import { Either, Encoding, Schema } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  type CertifiedHeadAdvance,
  type CertifiedHistoryHead,
  planCertifiedEvidenceEnrichment,
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

interface OpaqueVoteEvidence {
  readonly fixture: string;
}

const voteEvidenceFor = (signerAgentId: AgentIdValue): OpaqueVoteEvidence => ({
  fixture: `verified:${signerAgentId}`,
});

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
): DurabilityVoteProgress<string, OpaqueVoteEvidence> =>
  Either.match(
    makeDurabilityVoteProgress<string, OpaqueVoteEvidence>({
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
  progress: DurabilityVoteProgress<string, OpaqueVoteEvidence>,
  signers: readonly AgentIdValue[],
): DurabilityVoteProgress<string, OpaqueVoteEvidence> => {
  let current = progress;
  for (const signerAgentId of signers) {
    current = Either.match(
      mergeVerifiedDurabilityVote({
        progress: current,
        vote: {
          recordHash: current.recordHash,
          signerAgentId,
          evidence: voteEvidenceFor(signerAgentId),
        },
        sameRecordHash: (left, right) => left === right,
        sameVoteEvidence: (left, right) => left.fixture === right.fixture,
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
  readonly voteProgress: DurabilityVoteProgress<string, OpaqueVoteEvidence>;
}) =>
  planCertifiedHeadAdvance({
    ...input,
    sameRecordHash: (left, right) => left === right,
  });

const successfulTransition = (
  result: ReturnType<typeof transition>,
): CertifiedHeadAdvance<
  string,
  { readonly content: string },
  OpaqueVoteEvidence
> =>
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

const evidenceFor = (
  signers: readonly AgentIdValue[],
): Map<AgentIdValue, OpaqueVoteEvidence> =>
  new Map(
    signers.map((signerAgentId) => [
      signerAgentId,
      voteEvidenceFor(signerAgentId),
    ]),
  );

const enrichment = (input: {
  readonly existingProgress: DurabilityVoteProgress<string, OpaqueVoteEvidence>;
  readonly receivedProgress: DurabilityVoteProgress<string, OpaqueVoteEvidence>;
}) =>
  planCertifiedEvidenceEnrichment({
    ...input,
    sameRecordHash: (left, right) => left === right,
    sameVoteEvidence: (left, right) => left.fixture === right.fixture,
  });

const successfulEnrichment = (result: ReturnType<typeof enrichment>) =>
  Either.match(result, {
    onLeft: (error) => {
      throw error;
    },
    onRight: (plan) => plan,
  });

const failedEnrichment = (result: ReturnType<typeof enrichment>) =>
  Either.match(result, {
    onLeft: (error) => error,
    onRight: () => {
      throw new Error("Expected certified evidence enrichment to fail");
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

        expect(advance.staged).toEqual(staged);
        expect(new Map(advance.durabilityEvidenceBySigner)).toEqual(
          new Map(progress.voteEvidenceBySigner),
        );
        expect(advance.nextHead).toEqual({
          _tag: "certified",
          recordHash: NEXT_HASH,
        });
        expect(advance.staged).not.toBe(staged);
        expect(advance.durabilityEvidenceBySigner).not.toBe(
          progress.voteEvidenceBySigner,
        );
        expect(Object.isFrozen(advance.staged)).toBe(true);
        expect(Object.isFrozen(advance.nextHead)).toBe(true);
      }),
    );
  });
});

describe("planCertifiedHeadAdvance evidence snapshot", () => {
  it("keeps an independent complete-evidence snapshot after planning", () => {
    const members = membersFor(4);
    const initial = emptyProgress(NEXT_HASH, members);
    const progress = addSigners(
      initial,
      members.slice(0, initial.quorum.requiredVotes),
    );
    const mutableEvidence = new Map(progress.voteEvidenceBySigner);
    const mutableProgress = {
      ...progress,
      voteEvidenceBySigner: mutableEvidence,
    };
    const advance = successfulTransition(
      transition({
        currentHead: { _tag: "empty" },
        staged: stage(NEXT_HASH, null),
        voteProgress: mutableProgress,
      }),
    );
    mutableEvidence.clear();

    expect(new Map(advance.durabilityEvidenceBySigner)).toEqual(
      new Map(
        members
          .slice(0, initial.quorum.requiredVotes)
          .map((signerAgentId) => [
            signerAgentId,
            voteEvidenceFor(signerAgentId),
          ]),
      ),
    );
    for (const name of ["set", "delete", "clear"]) {
      expect(
        Reflect.get(advance.durabilityEvidenceBySigner, name),
      ).toBeUndefined();
    }
    expect(advance.durabilityEvidenceBySigner.size).toBe(
      initial.quorum.requiredVotes,
    );
  });
});

describe("planCertifiedEvidenceEnrichment record binding", () => {
  it("rejects votes for another certified history position", () => {
    const members = membersFor(4);
    const progress = addSigners(emptyProgress(NEXT_HASH, members), members);

    expect(
      failedEnrichment(
        enrichment({
          existingProgress: addSigners(
            emptyProgress(GENESIS_HASH, members),
            members.slice(0, 3),
          ),
          receivedProgress: progress,
        }),
      ),
    ).toMatchObject({
      _tag: "CertifiedEvidenceRecordMismatchError",
      existingRecordHash: GENESIS_HASH,
      receivedRecordHash: NEXT_HASH,
    });
  });
});

describe("planCertifiedEvidenceEnrichment membership binding", () => {
  it("rejects a different membership even when its threshold is complete", () => {
    const existingMembers = membersFor(4);
    const receivedMembers = [...existingMembers.slice(0, 3), makeAgentId(99)];

    expect(
      failedEnrichment(
        enrichment({
          existingProgress: addSigners(
            emptyProgress(GENESIS_HASH, existingMembers),
            existingMembers.slice(0, 3),
          ),
          receivedProgress: addSigners(
            emptyProgress(GENESIS_HASH, receivedMembers),
            receivedMembers.slice(0, 3),
          ),
        }),
      ),
    ).toMatchObject({
      _tag: "CertifiedEvidenceMembershipMismatchError",
      existingMemberCount: 4,
      receivedMemberCount: 4,
    });
  });
});

describe("planCertifiedEvidenceEnrichment certificate precondition", () => {
  it("refuses to treat partial stored evidence as an existing certificate", () => {
    const members = membersFor(4);
    const progress = addSigners(
      emptyProgress(GENESIS_HASH, members),
      members.slice(2),
    );

    expect(
      failedEnrichment(
        enrichment({
          existingProgress: addSigners(
            emptyProgress(GENESIS_HASH, members),
            members.slice(0, 2),
          ),
          receivedProgress: progress,
        }),
      ),
    ).toMatchObject({
      _tag: "ExistingCertifiedEvidenceIncompleteError",
      signerCount: 2,
      requiredVotes: 3,
    });
  });
});

describe("planCertifiedEvidenceEnrichment membership", () => {
  it("rejects a stored signer outside the fixed membership", () => {
    const members = membersFor(4);
    const outsider = makeAgentId(99);
    const existing = addSigners(
      emptyProgress(GENESIS_HASH, members),
      members.slice(0, 3),
    );
    const existingEvidence = new Map(existing.voteEvidenceBySigner);
    existingEvidence.set(outsider, voteEvidenceFor(outsider));

    expect(
      failedEnrichment(
        enrichment({
          existingProgress: {
            ...existing,
            voteEvidenceBySigner: existingEvidence,
          },
          receivedProgress: emptyProgress(GENESIS_HASH, members),
        }),
      ),
    ).toMatchObject({
      _tag: "NonMemberDurabilitySignerError",
      signerAgentId: outsider,
    });
  });
});

describe("planCertifiedEvidenceEnrichment conflicts", () => {
  it("rejects conflicting evidence without replacing the stored vote", () => {
    const members = membersFor(4);
    const signerAgentId = members.at(0);
    if (signerAgentId === undefined) {
      throw new Error("The four-member fixture must have a first signer");
    }
    const progress = emptyProgress(GENESIS_HASH, members);
    const conflictingProgress = {
      ...progress,
      voteEvidenceBySigner: new Map([
        [signerAgentId, { fixture: "verified:conflict" }],
      ]),
    };

    expect(
      failedEnrichment(
        enrichment({
          existingProgress: addSigners(
            emptyProgress(GENESIS_HASH, members),
            members.slice(0, 3),
          ),
          receivedProgress: conflictingProgress,
        }),
      ),
    ).toMatchObject({
      _tag: "ConflictingDurabilityVoteEvidenceError",
      signerAgentId,
      existingEvidence: voteEvidenceFor(signerAgentId),
      receivedEvidence: { fixture: "verified:conflict" },
    });
  });
});

describe("planCertifiedEvidenceEnrichment merge", () => {
  it("enriches every valid threshold subset at the same history position", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), (memberCount) => {
        const members = membersFor(memberCount);
        const initial = emptyProgress(GENESIS_HASH, members);
        const existing = addSigners(
          initial,
          members.slice(0, initial.quorum.requiredVotes),
        );
        const received = addSigners(initial, [...members].reverse());
        const plan = successfulEnrichment(
          enrichment({
            existingProgress: existing,
            receivedProgress: received,
          }),
        );

        expect(new Map(plan.durabilityEvidenceBySigner)).toEqual(
          evidenceFor(members),
        );
        expect(plan.disposition).toBe(
          memberCount === initial.quorum.requiredVotes
            ? "unchanged"
            : "enriched",
        );
        expect(plan.recordHash).toBe(GENESIS_HASH);
        expect(Object.isFrozen(plan)).toBe(true);
        for (const name of ["set", "delete", "clear"]) {
          expect(
            Reflect.get(plan.durabilityEvidenceBySigner, name),
          ).toBeUndefined();
        }
        expect("nextHead" in plan).toBe(false);
      }),
    );
  });
});
