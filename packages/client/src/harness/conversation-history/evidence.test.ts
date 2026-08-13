/**
 * @file Pins one shared evidence collector for exact action signatures and
 * quorum durability or re-anchor votes.
 */

import { AgentId, type AgentId as AgentIdValue } from "@moltzap/identity";
import { Either, Encoding, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  type EvidenceProgress,
  makeEvidenceProgress,
  mergeVerifiedEvidence,
} from "./evidence.js";

const member = (seed: number): AgentIdValue =>
  Schema.decodeUnknownSync(AgentId)(
    `agt_${Encoding.encodeBase64Url(new Uint8Array(16).fill(seed))}`,
  );

const MEMBERS = [member(1), member(2), member(3), member(4)] as const;
const OUTSIDER = member(250);
const SUBJECT = "record:one";

const voteFor = (signerAgentId: AgentIdValue): string =>
  `vote:${signerAgentId}`;

const progress = (requirement: "all-members" | "durability-quorum") =>
  Either.getOrThrow(
    makeEvidenceProgress<string, string>({
      subject: SUBJECT,
      memberAgentIds: new Set(MEMBERS),
      requirement,
    }),
  );

const merge = (
  current: EvidenceProgress<string, string>,
  signerAgentId: AgentIdValue,
  evidence: string,
  subject: string,
) =>
  mergeVerifiedEvidence({
    progress: current,
    received: { subject, signerAgentId, evidence },
    sameSubject: (left, right) => left === right,
    sameEvidence: (left, right) => left === right,
  });

const mergeDefault = (
  current: EvidenceProgress<string, string>,
  signerAgentId: AgentIdValue,
) => merge(current, signerAgentId, voteFor(signerAgentId), SUBJECT);

const failed = <Success, Failure>(result: Either.Either<Success, Failure>) =>
  Either.match(result, {
    onLeft: (error) => error,
    onRight: () => {
      throw new Error("Expected evidence collection to fail");
    },
  });

// @agent-code-guard/regression-only: these examples pin invalid membership and exact-member completion.
describe("fixed-member evidence requirements", () => {
  it("rejects empty membership", () => {
    expect(
      failed(
        makeEvidenceProgress({
          subject: SUBJECT,
          memberAgentIds: new Set<AgentIdValue>(),
          requirement: "all-members",
        }),
      ),
    ).toMatchObject({ _tag: "InvalidMembershipSizeError", memberCount: 0 });
  });

  it("completes exact evidence only on the final member", () => {
    let current = progress("all-members");
    for (const [index, signerAgentId] of MEMBERS.entries()) {
      const merged = Either.getOrThrow(mergeDefault(current, signerAgentId));
      current = merged.progress;
      expect(merged.completion === null).toBe(index < MEMBERS.length - 1);
    }
    expect(current.evidenceBySigner.map((item) => item.signerAgentId)).toEqual(
      MEMBERS,
    );
  });
});

// @agent-code-guard/regression-only: these examples distinguish quorum completion, retry, conflict, and binding behavior.
describe("fixed-member evidence merging", () => {
  it("completes quorum evidence once and then enriches it", () => {
    let current = progress("durability-quorum");
    for (const signerAgentId of MEMBERS.slice(0, 2)) {
      current = Either.getOrThrow(
        mergeDefault(current, signerAgentId),
      ).progress;
    }
    const completed = Either.getOrThrow(mergeDefault(current, MEMBERS[2]));
    const enriched = Either.getOrThrow(
      mergeDefault(completed.progress, MEMBERS[3]),
    );

    expect(completed).toMatchObject({
      disposition: "completed",
      newlyCompleted: true,
    });
    expect(enriched).toMatchObject({
      disposition: "enriched",
      newlyCompleted: false,
    });
    expect(enriched.completion?.evidenceBySigner).toHaveLength(4);
  });

  it("keeps duplicates harmless and rejects conflicts", () => {
    const first = Either.getOrThrow(
      mergeDefault(progress("all-members"), MEMBERS[0]),
    );
    const duplicate = Either.getOrThrow(
      mergeDefault(first.progress, MEMBERS[0]),
    );
    const conflict = failed(
      merge(first.progress, MEMBERS[0], "vote:conflict", SUBJECT),
    );

    expect(duplicate).toMatchObject({ disposition: "duplicate" });
    expect(duplicate.progress).toBe(first.progress);
    expect(conflict).toMatchObject({
      _tag: "ConflictingSignerEvidenceError",
      signerAgentId: MEMBERS[0],
    });
  });
});

// @agent-code-guard/regression-only: this example pins subject-first refusal and detached collection ownership.
describe("fixed-member evidence binding", () => {
  it("fails subject binding before membership and snapshots arrays", () => {
    const members = new Set<AgentIdValue>(MEMBERS);
    const current = Either.getOrThrow(
      makeEvidenceProgress<string, string>({
        subject: SUBJECT,
        memberAgentIds: members,
        requirement: "all-members",
      }),
    );
    members.clear();

    expect(
      failed(merge(current, OUTSIDER, "vote", "record:other")),
    ).toMatchObject({ _tag: "EvidenceSubjectMismatchError" });
    expect(current.memberAgentIds).toEqual(MEMBERS);
    expect(Object.isFrozen(current.memberAgentIds)).toBe(true);
    expect(Object.isFrozen(current.evidenceBySigner)).toBe(true);
  });
});
