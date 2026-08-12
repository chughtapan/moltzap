/**
 * @file Pins body binding, threshold gating, and independent complete-evidence
 * snapshots for promotion of one staged Router re-anchor.
 */

import { AgentId, type AgentId as AgentIdValue } from "@moltzap/identity";
import { Either, Encoding, Schema } from "effect";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { StagedReanchorCandidate } from "./reanchor-candidate-slot.js";
import {
  planReanchorAdvance,
  type ReanchorAdvance,
} from "./reanchor-advance.js";
import {
  makeReanchorVoteProgress,
  mergeVerifiedReanchorVote,
  type ReanchorVoteProgress,
} from "./reanchor-vote-progress.js";

interface OpaqueDomain {
  readonly fixture: string;
}

interface OpaqueBodyHash {
  readonly fixture: string;
}

interface OpaqueVoteEvidence {
  readonly fixture: string;
}

const DOMAIN = { fixture: "domain:current" } satisfies OpaqueDomain;
const BODY_HASH = { fixture: "body:current" } satisfies OpaqueBodyHash;
const OTHER_BODY_HASH = { fixture: "body:other" } satisfies OpaqueBodyHash;

type Candidate = StagedReanchorCandidate<OpaqueDomain, OpaqueBodyHash>;
type Progress = ReanchorVoteProgress<OpaqueBodyHash, OpaqueVoteEvidence>;

const sameBodyHash = (left: OpaqueBodyHash, right: OpaqueBodyHash): boolean =>
  left.fixture === right.fixture;

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
  bodyHash: OpaqueBodyHash,
  members: readonly AgentIdValue[],
): Progress =>
  Either.match(
    makeReanchorVoteProgress<OpaqueBodyHash, OpaqueVoteEvidence>({
      bodyHash,
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
  progress: Progress,
  signers: readonly AgentIdValue[],
): Progress => {
  let current = progress;
  for (const signerAgentId of signers) {
    current = Either.match(
      mergeVerifiedReanchorVote({
        progress: current,
        vote: {
          bodyHash: current.bodyHash,
          signerAgentId,
          evidence: voteEvidenceFor(signerAgentId),
        },
        sameBodyHash,
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

const candidate = (bodyHash = BODY_HASH): Candidate => ({
  domain: DOMAIN,
  bodyHash,
});

const transition = (staged: Candidate, voteProgress: Progress) =>
  planReanchorAdvance({ staged, voteProgress, sameBodyHash });

const successfulTransition = (
  result: ReturnType<typeof transition>,
): ReanchorAdvance<OpaqueDomain, OpaqueBodyHash, OpaqueVoteEvidence> =>
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
      throw new Error("Expected re-anchor advance to fail");
    },
  });

describe("planReanchorAdvance binding", () => {
  it("rejects another body before considering its incomplete threshold", () => {
    const members = membersFor(4);
    const progress = emptyProgress(OTHER_BODY_HASH, members);

    expect(failedTransition(transition(candidate(), progress))).toMatchObject({
      _tag: "StagedReanchorVoteMismatchError",
      stagedBodyHash: BODY_HASH,
      voteBodyHash: OTHER_BODY_HASH,
    });
  });
});

describe("planReanchorAdvance incomplete threshold", () => {
  it("rejects one vote below every fixed-membership threshold", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (memberCount) => {
        const members = membersFor(memberCount);
        const initial = emptyProgress(BODY_HASH, members);
        const progress = addSigners(
          initial,
          members.slice(0, initial.quorum.requiredVotes - 1),
        );

        expect(
          failedTransition(transition(candidate(), progress)),
        ).toMatchObject({
          _tag: "IncompleteReanchorEvidenceError",
          signerCount: initial.quorum.requiredVotes - 1,
          requiredVotes: initial.quorum.requiredVotes,
        });
      }),
    );
  });
});

describe("planReanchorAdvance completed threshold", () => {
  it("plans the exact staged anchor and complete evidence at every threshold", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (memberCount) => {
        const members = membersFor(memberCount);
        const initial = emptyProgress(BODY_HASH, members);
        const progress = addSigners(
          initial,
          members.slice(0, initial.quorum.requiredVotes),
        );
        const staged = candidate();
        const advance = successfulTransition(transition(staged, progress));

        expect(advance).toEqual({
          currentAnchor: staged,
          reanchorEvidenceBySigner: progress.voteEvidenceBySigner,
        });
        expect(advance.currentAnchor).not.toBe(staged);
        expect(advance.reanchorEvidenceBySigner).not.toBe(
          progress.voteEvidenceBySigner,
        );
        expect(Object.isFrozen(advance.currentAnchor)).toBe(true);
      }),
    );
  });
});

describe("planReanchorAdvance evidence snapshot", () => {
  it("keeps its complete evidence after the input map changes", () => {
    const members = membersFor(4);
    const initial = emptyProgress(BODY_HASH, members);
    const complete = addSigners(
      initial,
      members.slice(0, initial.quorum.requiredVotes),
    );
    const mutableEvidence = new Map(complete.voteEvidenceBySigner);
    const progress = { ...complete, voteEvidenceBySigner: mutableEvidence };
    const advance = successfulTransition(transition(candidate(), progress));
    const expectedEvidence = new Map(mutableEvidence);

    mutableEvidence.clear();

    expect(advance.reanchorEvidenceBySigner).toEqual(expectedEvidence);
    expect(advance.reanchorEvidenceBySigner.size).toBe(
      initial.quorum.requiredVotes,
    );
  });
});
