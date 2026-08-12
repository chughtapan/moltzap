/** @file Pins fail-closed restart recovery for durable conversation records. */

import { AgentId, type AgentId as AgentIdValue } from "@moltzap/identity";
import { Either, Encoding, Schema } from "effect";
import { describe, expect, it } from "vitest";

import type {
  CertifiedHistoryHead,
  StagedActionCertifiedRecord,
} from "./certified-head-advance.js";
import { planCertifiedRestartRecovery } from "./certified-restart-recovery.js";
import {
  type DurabilityVoteProgress,
  makeDurabilityVoteProgress,
  mergeVerifiedDurabilityVote,
} from "./durability-vote-progress.js";

const PREVIOUS_HASH = "record:previous";
const RECORD_HASH = "record:current";
const OTHER_HASH = "record:other";

interface OpaqueRecord {
  readonly content: string;
}

interface OpaqueVoteEvidence {
  readonly fixture: string;
}

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

const progressFor = (
  recordHash: string,
  signerCount: number,
): DurabilityVoteProgress<string, OpaqueVoteEvidence> => {
  let progress = Either.match(
    makeDurabilityVoteProgress<string, OpaqueVoteEvidence>({
      recordHash,
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
      mergeVerifiedDurabilityVote({
        progress,
        vote: {
          recordHash,
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

  return progress;
};

const staged = (
  previousRecordHash: string | null,
  recordHash = RECORD_HASH,
): StagedActionCertifiedRecord<string, OpaqueRecord> => ({
  recordHash,
  previousRecordHash,
  record: { content: `content:${recordHash}` },
});

const transition = (input: {
  readonly currentHead: CertifiedHistoryHead<string>;
  readonly staged: StagedActionCertifiedRecord<string, OpaqueRecord>;
  readonly voteProgress: DurabilityVoteProgress<string, OpaqueVoteEvidence>;
}) =>
  planCertifiedRestartRecovery({
    ...input,
    sameRecordHash: (left, right) => left === right,
  });

const successfulRecovery = (
  result: ReturnType<typeof transition>,
) =>
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
      throw new Error("Expected restart recovery to fail");
    },
  });

describe("planCertifiedRestartRecovery incomplete durable state", () => {
  it.each([0, 2])(
    "keeps %i verified votes out of history and resumes collection",
    (signerCount) => {
      const currentHead = { _tag: "empty" as const };
      const recovery = successfulRecovery(
        transition({
          currentHead,
          staged: staged(null),
          voteProgress: progressFor(RECORD_HASH, signerCount),
        }),
      );

      expect(recovery).toEqual({
        _tag: "collecting",
        recordHash: RECORD_HASH,
        signerCount,
        requiredVotes: 3,
      });
      expect(currentHead).toEqual({ _tag: "empty" });
      expect(recovery).not.toHaveProperty("advance");
    },
  );
});

describe("planCertifiedRestartRecovery quorum completion", () => {
  it("returns one atomic promotion plan when recovered votes meet threshold", () => {
    const progress = progressFor(RECORD_HASH, 3);
    const recovery = successfulRecovery(
      transition({
        currentHead: { _tag: "certified", recordHash: PREVIOUS_HASH },
        staged: staged(PREVIOUS_HASH),
        voteProgress: progress,
      }),
    );

    expect(recovery).toMatchObject({
      _tag: "promotion",
      advance: {
        staged: { recordHash: RECORD_HASH },
        nextHead: { _tag: "certified", recordHash: RECORD_HASH },
      },
    });
    if (recovery._tag !== "promotion") {
      throw new Error("Expected promotion recovery");
    }
    expect(recovery.advance.durabilityEvidenceBySigner.size).toBe(
      progress.voteEvidenceBySigner.size,
    );
  });
});

describe("planCertifiedRestartRecovery completed local promotion", () => {
  it.each([0, 3])(
    "does not repeat or forget a completed promotion with %i retained votes",
    (signerCount) => {
      const recovery = successfulRecovery(
        transition({
          currentHead: { _tag: "certified", recordHash: RECORD_HASH },
          staged: staged(PREVIOUS_HASH),
          voteProgress: progressFor(RECORD_HASH, signerCount),
        }),
      );

      expect(recovery).toEqual({
        _tag: "certified",
        recordHash: RECORD_HASH,
      });
      expect(recovery).not.toHaveProperty("advance");
    },
  );
});

describe("planCertifiedRestartRecovery consistency refusal", () => {
  it("rejects vote progress for another record before accepting a certified retry", () => {
    expect(
      failedRecovery(
        transition({
          currentHead: { _tag: "certified", recordHash: RECORD_HASH },
          staged: staged(PREVIOUS_HASH),
          voteProgress: progressFor(OTHER_HASH, 3),
        }),
      ),
    ).toMatchObject({
      _tag: "StagedRecordVoteMismatchError",
      stagedRecordHash: RECORD_HASH,
      voteRecordHash: OTHER_HASH,
    });
  });

  it("rejects stale staged ancestry instead of resuming partial collection", () => {
    expect(
      failedRecovery(
        transition({
          currentHead: { _tag: "certified", recordHash: PREVIOUS_HASH },
          staged: staged(OTHER_HASH),
          voteProgress: progressFor(RECORD_HASH, 2),
        }),
      ),
    ).toMatchObject({
      _tag: "CertifiedPredecessorMismatchError",
      expectedPreviousRecordHash: PREVIOUS_HASH,
      receivedPreviousRecordHash: OTHER_HASH,
    });
  });
});
