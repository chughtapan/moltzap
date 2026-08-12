/** @file Pins fail-closed restart recovery for durable Router re-anchors. */

import { AgentId, type AgentId as AgentIdValue } from "@moltzap/identity";
import { Either, Encoding, Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { StagedReanchorCandidate } from "./reanchor-candidate-slot.js";
import { planReanchorRestartRecovery } from "./reanchor-restart-recovery.js";
import {
  makeReanchorVoteProgress,
  mergeVerifiedReanchorVote,
  type ReanchorVoteProgress,
} from "./reanchor-vote-progress.js";

const PREVIOUS_BODY_HASH = "anchor-body:previous";
const BODY_HASH = "anchor-body:current";
const OTHER_BODY_HASH = "anchor-body:other";

interface OpaqueDomain {
  readonly fixture: string;
}

interface OpaqueVoteEvidence {
  readonly fixture: string;
}

type Candidate = StagedReanchorCandidate<OpaqueDomain, string>;
type Progress = ReanchorVoteProgress<string, OpaqueVoteEvidence>;

const makeAgentId = (seed: number): AgentIdValue =>
  Schema.decodeUnknownSync(AgentId)(
    `agt_${Encoding.encodeBase64Url(new Uint8Array(16).fill(seed))}`,
  );

const MEMBERS = Object.freeze([
  makeAgentId(0),
  makeAgentId(1),
  makeAgentId(2),
  makeAgentId(3),
]);

const voteEvidenceFor = (
  signerAgentId: AgentIdValue,
): OpaqueVoteEvidence => ({ fixture: `verified:${signerAgentId}` });

const progressFor = (bodyHash: string, signerCount: number): Progress => {
  let progress = Either.match(
    makeReanchorVoteProgress<string, OpaqueVoteEvidence>({
      bodyHash,
      memberAgentIds: new Set(MEMBERS),
    }),
    {
      onLeft: (error) => {
        throw error;
      },
      onRight: (created) => created,
    },
  );

  for (const signerAgentId of MEMBERS.slice(0, signerCount)) {
    progress = Either.match(
      mergeVerifiedReanchorVote({
        progress,
        vote: {
          bodyHash,
          signerAgentId,
          evidence: voteEvidenceFor(signerAgentId),
        },
        sameBodyHash: (left, right) => left === right,
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

  return progress;
};

const candidate = (bodyHash: string, domain: string): Candidate => ({
  domain: { fixture: domain },
  bodyHash,
});

const CURRENT_ANCHOR = candidate(PREVIOUS_BODY_HASH, "domain:previous");
const STAGED_ANCHOR = candidate(BODY_HASH, "domain:current");

const transition = (input: {
  readonly currentAnchor: Candidate;
  readonly staged: Candidate;
  readonly voteProgress: Progress;
  readonly extendsCurrent?: boolean;
}) =>
  planReanchorRestartRecovery({
    currentAnchor: input.currentAnchor,
    staged: input.staged,
    voteProgress: input.voteProgress,
    sameBodyHash: (left, right) => left === right,
    stagedExtendsCurrentAnchor: () => input.extendsCurrent ?? true,
  });

const successfulRecovery = (result: ReturnType<typeof transition>) =>
  Either.match(result, {
    onLeft: (error) => {
      throw error;
    },
    onRight: (recovery) => recovery,
  });

const failedRecovery = (result: ReturnType<typeof transition>) =>
  Either.match(result, {
    onLeft: (error) => error,
    onRight: () => {
      throw new Error("Expected re-anchor restart recovery to fail");
    },
  });

describe("planReanchorRestartRecovery incomplete durable state", () => {
  it.each([0, 2])(
    "keeps %i verified votes below current and resumes collection",
    (signerCount) => {
      const recovery = successfulRecovery(
        transition({
          currentAnchor: CURRENT_ANCHOR,
          staged: STAGED_ANCHOR,
          voteProgress: progressFor(BODY_HASH, signerCount),
        }),
      );

      expect(recovery).toEqual({
        _tag: "collecting",
        bodyHash: BODY_HASH,
        signerCount,
        requiredVotes: 3,
      });
      expect(recovery).not.toHaveProperty("advance");
    },
  );
});

describe("planReanchorRestartRecovery quorum completion", () => {
  it("returns the atomic re-anchor advance when recovered votes meet threshold", () => {
    const progress = progressFor(BODY_HASH, 3);
    const recovery = successfulRecovery(
      transition({
        currentAnchor: CURRENT_ANCHOR,
        staged: STAGED_ANCHOR,
        voteProgress: progress,
      }),
    );

    expect(recovery).toMatchObject({
      _tag: "promotion",
      advance: { currentAnchor: STAGED_ANCHOR },
    });
    if (recovery._tag !== "promotion") {
      throw new Error("Expected re-anchor promotion recovery");
    }
    expect(recovery.advance.reanchorEvidenceBySigner.size).toBe(
      progress.voteEvidenceBySigner.size,
    );
  });
});

describe("planReanchorRestartRecovery completed local promotion", () => {
  it.each([0, 3])(
    "does not repeat a current anchor with %i retained votes",
    (signerCount) => {
      const durableCurrent = candidate(BODY_HASH, "domain:current");
      const recovery = successfulRecovery(
        transition({
          currentAnchor: durableCurrent,
          staged: STAGED_ANCHOR,
          voteProgress: progressFor(BODY_HASH, signerCount),
          extendsCurrent: false,
        }),
      );

      expect(recovery).toEqual({ _tag: "current", bodyHash: BODY_HASH });
      expect(recovery).not.toHaveProperty("advance");
    },
  );
});

describe("planReanchorRestartRecovery consistency refusal", () => {
  it("rejects vote progress for another body before accepting a current retry", () => {
    expect(
      failedRecovery(
        transition({
          currentAnchor: STAGED_ANCHOR,
          staged: STAGED_ANCHOR,
          voteProgress: progressFor(OTHER_BODY_HASH, 3),
        }),
      ),
    ).toMatchObject({
      _tag: "StagedReanchorVoteMismatchError",
      stagedBodyHash: BODY_HASH,
      voteBodyHash: OTHER_BODY_HASH,
    });
  });

  it.each([0, 3])(
    "rejects unrelated durable ancestry with %i retained votes",
    (signerCount) => {
      expect(
        failedRecovery(
          transition({
            currentAnchor: CURRENT_ANCHOR,
            staged: STAGED_ANCHOR,
            voteProgress: progressFor(BODY_HASH, signerCount),
            extendsCurrent: false,
          }),
        ),
      ).toMatchObject({
        _tag: "ReanchorPredecessorMismatchError",
        currentAnchorBodyHash: PREVIOUS_BODY_HASH,
        stagedAnchorBodyHash: BODY_HASH,
      });
    },
  );
});
